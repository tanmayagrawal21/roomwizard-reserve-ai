/**
 * Availability: fan out across the fleet, then turn booking lists into free
 * windows.
 *
 * Two properties matter here.
 *
 * Partial success. One appliance being down must not blank the whole week, so
 * the fan-out uses allSettled and reports per-room errors alongside the rooms
 * that did answer. The UI can then grey out one column instead of showing an
 * error page.
 *
 * Honest gaps. Free windows are intersected with the bookable window
 * (07:00-19:00 local) per day, so a "free" range never includes hours the
 * appliance would refuse to book.
 */

import { CACHE_TTL_MS, MAX_CONCURRENCY } from "./config.ts";
import { TtlCache } from "./cache.ts";
import { ApplianceError, fetchBookings, type RawBooking } from "./roomwizard.ts";
import { getFleet, type Fleet, type Room } from "./rooms.ts";
import {
  atLocalTime,
  eachLocalDay,
  parseApplianceTimestamp,
  toIso,
  type Instant,
} from "./time.ts";

export interface Booking {
  id: string;
  roomId: string;
  start: string;
  end: string;
  /** Null when the booking is confidential — the appliance hides the subject. */
  purpose: string | null;
  host: string | null;
  /**
   * Optional — the appliance only has this if the booking's creator chose to
   * give one (there is no account system to source it from). Hidden under
   * the same rule as `purpose`/`host` when the booking is confidential.
   */
  hostEmail: string | null;
  isConfidential: boolean;
  createdAt: string | null;
}

export interface Interval {
  start: string;
  end: string;
}

export interface RoomAvailability {
  room: Room;
  busy: Booking[];
  free: Interval[];
}

export interface AvailabilityResult {
  from: string;
  to: string;
  fleet: Omit<Fleet, "rooms">;
  rooms: RoomAvailability[];
  /** Rooms that failed to answer, so the UI can distinguish empty from unknown. */
  errors: { roomId: string; host: string; message: string }[];
}

/**
 * Strip the fields a client must never see.
 *
 * `password` carries credential material that the appliance includes in its own
 * responses (PLAN.md section 7). Dropping it here is the single most important
 * line in this file: it keeps our front-end from re-publishing that to every
 * browser which loads the app.
 *
 * Confidential bookings also get their subject and host withheld, matching what
 * the appliance's own UI does.
 */
/** A normalized booking plus the parsed instants, for internal arithmetic. */
export interface TimedBooking {
  booking: Booking;
  start: Instant;
  end: Instant;
}

export function normalizeBooking(raw: RawBooking, roomId: string): TimedBooking | null {
  let start: Instant;
  let end: Instant;
  try {
    start = parseApplianceTimestamp(raw.start);
    end = parseApplianceTimestamp(raw.end);
  } catch {
    // A booking we cannot place in time is worse than useless — it would
    // silently distort the free/busy map. Drop it.
    return null;
  }

  const hidden = raw.isConfidential === true || raw.hideMeetingDetails === true;
  const host = [raw.hostFirstName, raw.hostLastName]
    .filter((p) => typeof p === "string" && p.trim() !== "")
    .join(" ")
    .trim();

  let createdAt: string | null = null;
  try {
    if (raw.creationDate) createdAt = toIso(parseApplianceTimestamp(raw.creationDate));
  } catch {
    createdAt = null;
  }

  return {
    start,
    end,
    booking: {
      id: String(raw.Id),
      roomId,
      start: toIso(start),
      end: toIso(end),
      purpose: hidden ? null : (raw.purpose ?? "").trim() || null,
      host: hidden ? null : host || null,
      hostEmail: hidden ? null : (raw.hostEmail ?? "").trim() || null,
      isConfidential: hidden,
      createdAt,
    },
  };
}

/**
 * Does a booking intersect the half-open window `[from, to)`?
 *
 * Needed because the Connector ignores the time components of its range
 * parameters and returns whole days: asking for Oct 8 00:00 -> Oct 9 00:00
 * also yields every Oct 9 booking. Verified live against the fleet. Without
 * this filter, `busy` carries bookings from outside the requested range and a
 * week grid renders them in the wrong column.
 */
export function overlapsRange(
  booking: { start: Instant; end: Instant },
  from: Instant,
  to: Instant,
): boolean {
  return booking.end.getTime() > from.getTime() && booking.start.getTime() < to.getTime();
}

/** Merge overlapping/adjacent intervals. Input need not be sorted. */
export function mergeIntervals(
  intervals: { start: Instant; end: Instant }[],
): { start: Instant; end: Instant }[] {
  const sorted = [...intervals]
    .filter((i) => i.end.getTime() > i.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: { start: Instant; end: Instant }[] = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last && cur.start.getTime() <= last.end.getTime()) {
      if (cur.end.getTime() > last.end.getTime()) last.end = cur.end;
    } else {
      merged.push({ start: cur.start, end: cur.end });
    }
  }
  return merged;
}

/**
 * Free windows within `[from, to)`, restricted to the bookable hours of each
 * day the range touches.
 */
export function computeFree(
  busy: { start: Instant; end: Instant }[],
  from: Instant,
  to: Instant,
  dayStartHour: number,
  dayEndHour: number,
): { start: Instant; end: Instant }[] {
  const merged = mergeIntervals(busy);
  const free: { start: Instant; end: Instant }[] = [];

  for (const day of eachLocalDay(from, to)) {
    // Clip the day's bookable window to the requested range.
    const windowStart = new Date(
      Math.max(atLocalTime(day, dayStartHour).getTime(), from.getTime()),
    );
    const windowEnd = new Date(
      Math.min(atLocalTime(day, 0).getTime() + dayEndHour * 3_600_000, to.getTime()),
    );
    if (windowEnd.getTime() <= windowStart.getTime()) continue;

    let cursor = windowStart;
    for (const b of merged) {
      if (b.end.getTime() <= cursor.getTime()) continue;
      if (b.start.getTime() >= windowEnd.getTime()) break;
      if (b.start.getTime() > cursor.getTime()) {
        free.push({ start: cursor, end: new Date(Math.min(b.start.getTime(), windowEnd.getTime())) });
      }
      if (b.end.getTime() > cursor.getTime()) cursor = b.end;
      if (cursor.getTime() >= windowEnd.getTime()) break;
    }
    if (cursor.getTime() < windowEnd.getTime()) {
      free.push({ start: cursor, end: windowEnd });
    }
  }

  return free;
}

/** Run `task` over `items` with a concurrency ceiling, never rejecting. */
async function mapSettled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await task(items[i]!) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

const bookingsCache = new TtlCache<RawBooking[]>(CACHE_TTL_MS.bookings);

function bookingsKey(room: Room, from: Instant, to: Instant): string {
  return `${room.id}:${from.getTime()}:${to.getTime()}`;
}

/** Bookings for one room, cached and coalesced. */
export async function getRoomBookings(
  room: Room,
  from: Instant,
  to: Instant,
): Promise<RawBooking[]> {
  return bookingsCache.fetch(bookingsKey(room, from, to), () =>
    fetchBookings(room.host, from, to),
  );
}

/** Drop every cached booking list. Called after a successful write. */
export function invalidateBookings(): void {
  bookingsCache.clear();
}

export async function getAvailability(from: Instant, to: Instant): Promise<AvailabilityResult> {
  const fleet = await getFleet(from);
  const { rooms, ...fleetMeta } = fleet;

  const settled = await mapSettled(rooms, MAX_CONCURRENCY, async (room) => {
    const raw = await getRoomBookings(room, from, to);
    return { room, raw };
  });

  const out: RoomAvailability[] = [];
  const errors: AvailabilityResult["errors"] = [];

  settled.forEach((result, i) => {
    const room = rooms[i]!;
    if (result.status === "rejected") {
      const reason = result.reason;
      errors.push({
        roomId: room.id,
        host: room.host,
        message:
          reason instanceof ApplianceError || reason instanceof Error
            ? reason.message
            : String(reason),
      });
      return;
    }

    const timed = result.value.raw
      .map((b) => normalizeBooking(b, room.id))
      .filter((b): b is TimedBooking => b !== null)
      .filter((b) => overlapsRange(b, from, to))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    const free = computeFree(
      timed,
      from,
      to,
      fleet.dayStartHour,
      fleet.dayEndHour,
    ).map((i) => ({ start: toIso(i.start), end: toIso(i.end) }));

    out.push({ room, busy: timed.map((t) => t.booking), free });
  });

  return { from: toIso(from), to: toIso(to), fleet: fleetMeta, rooms: out, errors };
}
