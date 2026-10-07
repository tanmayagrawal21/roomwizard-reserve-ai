/**
 * HTTP surface.
 *
 * Phase 1 is read-only: the roster and availability. Writes (`POST /api/book`,
 * `DELETE /api/booking/...`) land in Phase 3 — the appliance flow for those is
 * already mapped in PLAN.md section 2.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { ALLOWED_ORIGINS, MAX_RANGE_DAYS } from "./config.ts";
import { getAvailability } from "./availability.ts";
import { getFleet } from "./rooms.ts";
import { ApplianceError } from "./roomwizard.ts";
import { addDays, parseClientDateTime, startOfLocalDay, toIso } from "./time.ts";

const rangeQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  days: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).optional(),
});

export function createApp() {
  const app = new Hono();

  app.use("*", logger());
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
