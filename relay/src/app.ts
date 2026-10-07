/**
 * HTTP surface.
 *
 * Reads (`/api/rooms`, `/api/availability`) are Phase 1. Writes
 * (`POST /api/book`, `DELETE /api/booking/:roomId/:id`) are Phase 3 — the
 * appliance flow for those is mapped in PLAN.md section 2 and implemented in
 * `booking.ts`.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { ALLOWED_ORIGINS, MAX_RANGE_DAYS } from "./config.ts";
import {
  getAvailability,
  invalidateBookings,
  normalizeBooking,
  overlapsRange,
} from "./availability.ts";
import { findRoom, getFleet } from "./rooms.ts";
import { fetchBookings, ApplianceError } from "./roomwizard.ts";
import {
  BookingRejectedError,
  BookingValidationError,
  cancelBooking,
  createBooking,
  generateBookingPassword,
} from "./booking.ts";
import { addDays, localParts, parseClientDateTime, startOfLocalDay, toIso } from "./time.ts";

const rangeQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  days: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).optional(),
});

/** Matches `purposeRequired`/`hostRequired` on the appliance form — see PLAN.md section 2. */
const bookRequest = z.object({
  roomId: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  purpose: z.string().trim().min(1).max(50),
  hostFirstName: z.string().trim().max(50).optional().default(""),
  hostLastName: z.string().trim().max(50).optional().default(""),
  /** Caller-supplied password, or the relay generates one — see `generateBookingPassword`. */
  password: z.string().min(4).max(64).optional(),
});

const cancelRequest = z.object({
  password: z.string().min(1),
});

/** Longest booking the relay will create in one call. Guards against a fat-fingered multi-day request reaching saveBooking.action. */
const MAX_BOOKING_HOURS = 8;
const MIN_BOOKING_MINUTES = 5;

export function createApp() {
  const app = new Hono();

  app.use("*", logger());

  /**
   * Local Network Access opt-in.
   *
   * Chrome gates requests from a public page into the loopback/local address
   * space: a hosted UI fetching http://localhost:8787 is refused with
   * "Permission was denied for this request to access the `loopback` address
   * space" unless the target opts in on the preflight. Firefox and Safari have
   * their own stances, so this is best-effort.
   *
   * Both header spellings are sent because the header was renamed mid-rollout
   * (Private Network Access -> Local Network Access) and which one a given
   * Chrome build looks for depends on its version.
   *
   * This is only half the story: the browser also requires the user to grant a
   * permission prompt. A shared deployment should give the relay a real
   * hostname with a valid certificate rather than relying on this.
   */
  app.use("/api/*", async (c, next) => {
    await next();
    if (c.req.method !== "OPTIONS") return;
    const asked =
      c.req.header("access-control-request-private-network") ??
      c.req.header("access-control-request-local-network");
    if (asked === "true") {
      c.header("Access-Control-Allow-Private-Network", "true");
      c.header("Access-Control-Allow-Local-Network", "true");
    }
  });

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type"],
      maxAge: 86_400,
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, now: toIso(new Date()) }));

  /** The fleet: rooms, capacities, amenities, bookable hours. */
  app.get("/api/rooms", async (c) => {
    const fleet = await getFleet(new Date());
    return c.json(fleet);
  });

  /**
   * Free/busy across the fleet.
   *
   * `from`/`to` accept a bare local date (`2026-10-07`), a naive local datetime,
   * or a fully-qualified ISO string. Omitting them defaults to today; `days`
   * sets the span when `to` is absent.
   */
  app.get("/api/availability", async (c) => {
    const parsed = rangeQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
    }
    const { from: fromRaw, to: toRaw, days } = parsed.data;

    let from: Date;
    let to: Date;
    try {
      from = fromRaw ? startOfLocalDay(parseClientDateTime(fromRaw)) : startOfLocalDay(new Date());
      to = toRaw
        ? parseClientDateTime(toRaw)
        : addDays(from, days ?? 1);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    if (to.getTime() <= from.getTime()) {
      return c.json({ error: "`to` must be after `from`" }, 400);
    }

    const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (spanDays > MAX_RANGE_DAYS) {
      return c.json(
        { error: `Range too large: ${Math.ceil(spanDays)} days, max ${MAX_RANGE_DAYS}` },
        400,
      );
    }

    const result = await getAvailability(from, to);
    return c.json(result);
  });

  /**
   * Create a booking.
   *
   * Scoped deliberately narrow: one-off, non-recurring, with the four fields
   * the appliance actually requires (purpose, a name, start, end) plus an
   * optional password. Everything else the real form supports (recurrence,
   * invitees, cost centers, confidential) is out of scope for Phase 3.
   */
  app.post("/api/book", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = bookRequest.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;

    if (!body.hostFirstName && !body.hostLastName) {
      return c.json({ error: "hostFirstName or hostLastName is required" }, 400);
    }

    let start: Date;
    let end: Date;
    try {
      start = parseClientDateTime(body.start);
      end = parseClientDateTime(body.end);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
    if (durationMinutes < MIN_BOOKING_MINUTES) {
      return c.json({ error: "`end` must be after `start`" }, 400);
    }
    if (durationMinutes > MAX_BOOKING_HOURS * 60) {
      return c.json({ error: `Bookings longer than ${MAX_BOOKING_HOURS}h are not supported here` }, 400);
    }
    if (start.getTime() < Date.now() - 60_000) {
      return c.json({ error: "`start` is in the past" }, 400);
    }

    const fleet = await getFleet(start);
    const room = findRoom(fleet, body.roomId);
    if (!room) return c.json({ error: `No such room: ${body.roomId}` }, 404);
    if (!room.online) {
      return c.json({ error: `${room.name} is not responding right now` }, 502);
    }

    const startParts = localParts(start);
    const endParts = localParts(end);
    const startMin = startParts.hour * 60 + startParts.minute;
    // Midnight-exactly as an end time means "end of day", matching the
    // appliance's own "00 means 24" convention — not actually hour 0.
    const endMin =
      endParts.hour === 0 && endParts.minute === 0 && end.getTime() > start.getTime()
        ? fleet.dayEndHour * 60
        : endParts.hour * 60 + endParts.minute;
    if (startMin < fleet.dayStartHour * 60 || endMin > fleet.dayEndHour * 60) {
      return c.json(
        { error: `${room.name} is only bookable ${fleet.dayStartHour}:00–${fleet.dayEndHour}:00` },
        400,
      );
    }

    // Re-check availability immediately before writing. This narrows, but
    // cannot close, the gap between "the picker showed this slot free" and
    // "we're about to claim it" — see PLAN.md section 6 on the double-book
    // race the appliance does nothing to prevent itself.
    const rawExisting = await fetchBookings(room.host, start, end);
    const conflict = rawExisting
      .map((b) => normalizeBooking(b, room.id))
      .filter((b) => b !== null)
      .some((b) => overlapsRange(b, start, end));
    if (conflict) {
      return c.json({ error: `${room.name} was just booked for part of that time` }, 409);
    }

    const password = body.password ?? generateBookingPassword();

    try {
      const created = await createBooking({
        room,
        start,
        end,
        purpose: body.purpose,
        hostFirstName: body.hostFirstName,
        hostLastName: body.hostLastName,
        password,
      });
      invalidateBookings();
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof BookingRejectedError) {
        return c.json({ error: err.message }, 502);
      }
      throw err;
    }
  });

  /** Cancel a booking this app (or anyone who has its password) created. */
  app.delete("/api/booking/:roomId/:id", async (c) => {
    const roomId = c.req.param("roomId");
    const id = c.req.param("id");
    const json = await c.req.json().catch(() => null);
    const parsed = cancelRequest.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "A `password` body is required" }, 400);
    }

    const fleet = await getFleet(new Date());
    const room = findRoom(fleet, roomId);
    if (!room) return c.json({ error: `No such room: ${roomId}` }, 404);

    try {
      await cancelBooking({ room, bookingId: id, password: parsed.data.password });
      invalidateBookings();
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof BookingValidationError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof BookingRejectedError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof ApplianceError) {
      // The fleet, or the roster appliance, is unreachable. That is an upstream
      // failure, not a client error — 502 so callers can retry sensibly.
      console.error(`[appliance] ${err.host}: ${err.message}`, err.cause ?? "");
      return c.json({ error: "Appliance unreachable", detail: err.message, host: err.host }, 502);
    }
    console.error("[relay] unhandled", err);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
