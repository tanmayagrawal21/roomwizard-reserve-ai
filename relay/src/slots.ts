/**
 * Deterministic slot finding: "where can I put a 90-minute meeting for 6
 * people with a camera, Thursday afternoon?"
 *
 * This is the piece that keeps a small local model useful (PLAN.md section 5).
 * Rather than asking a 4B model to reason over 9 rooms x 7 days x 48 slots,
 * it picks among a short list of pre-scored candidates computed here. The
 * ranking is therefore part of the product, not an implementation detail, and
 * every candidate carries the reasons behind its score so both the chat and
 * the UI can explain a recommendation instead of asserting it.
 *
 * Hard filters (capacity, amenities, floor, time-of-day window) exclude.
 * Soft preferences (below) only reorder.
 */

import { getAvailability } from "./availability.ts";
import type { Amenity, Room } from "./rooms.ts";
import {
  addMinutes,
  localParts,
  parseClientDateTime,
  toIso,
  type Instant,
} from "./time.ts";

export interface FindSlotsQuery {
  from: Instant;
  to: Instant;
  durationMinutes: number;
  /** Earliest acceptable start, as a local wall-clock hour. */
  earliestHour?: number;
  /** Latest acceptable *end*, as a local wall-clock hour. */
  latestHour?: number;
  minCapacity?: number;
  /** All of these must be present. */
  amenities?: Amenity[];
  floor?: number;
  /** Restrict to specific rooms. Empty or omitted means the whole fleet. */
  roomIds?: string[];
  limit?: number;
}

export interface SlotCandidate {
  roomId: string;
  roomName: string;
  capacity: number;
  floor: number | null;
  amenities: Amenity[];
  start: string;
  end: string;
  /** 0..1, higher is better. See `scoreSlot` for the breakdown. */
  score: number;
  /** Human-readable justifications, best-first. Safe to show verbatim. */
  reasons: string[];
}

export interface FindSlotsResult {
  query: {
    from: string;
    to: string;
    durationMinutes: number;
    earliestHour: number | null;
    latestHour: number | null;
    minCapacity: number | null;
    amenities: Amenity[];
    floor: number | null;
  };
  candidates: SlotCandidate[];
  /** Total that passed every filter, before `limit` truncated the list. */
  totalFound: number;
  /**
   * Set when nothing matched, naming the most likely over-constraint so a
   * caller can suggest relaxing it rather than just saying "no results".
   */
  noMatchReason: string | null;
}

const DEFAULT_LIMIT = 12;

/** Scoring weights. Kept together so the ranking can be reasoned about in one place. */
const WEIGHT = {
  /** Sooner is better: most people asking for a room want the next usable one. */
  soonest: 0.5,
  /** Right-sized rooms: don't hand a 2-person meeting the 10-seat conference room. */
  rightSized: 0.3,
  /** Tidy placement: prefer not carving an unusable sliver out of a free gap. */
  tidyFit: 0.2,
} as const;

export function scoreSlot(args: {
  start: Instant;
  end: Instant;
  room: Room;
  /** The free interval this candidate sits inside. */
  gapStart: Instant;
  gapEnd: Instant;
  /**
   * Whether each edge of that gap is an actual adjacent booking rather than
   * the edge of the bookable day. Without this the scorer cannot tell
   * "tucked neatly against the 10:00 meeting" from "starts at 7am because
   * that is simply when the day opens", and claims the former for both.
   */
  gapStartIsBooking: boolean;
  gapEndIsBooking: boolean;
  /** Range bounds, for normalizing "how soon is this". */
  rangeStart: Instant;
  rangeEnd: Instant;
  requestedCapacity: number;
  slotMinutes: number;
}): { score: number; reasons: string[] } {
  const {
    start,
    end,
    room,
    gapStart,
    gapEnd,
    gapStartIsBooking,
    gapEndIsBooking,
    rangeStart,
    rangeEnd,
    requestedCapacity,
    slotMinutes,
  } = args;
  const reasons: string[] = [];

  // --- Soonest ---------------------------------------------------------
  const span = Math.max(1, rangeEnd.getTime() - rangeStart.getTime());
  const elapsed = start.getTime() - rangeStart.getTime();
  const soonest = 1 - Math.min(1, Math.max(0, elapsed / span));

  // --- Right-sized -----------------------------------------------------
  // Full marks when capacity matches the ask; falls off as the room gets
  // oversized. A room that merely *meets* the need always beats one that
  // wastes five extra seats, which matters on a shared fleet.
  let rightSized = 1;
  if (requestedCapacity > 0 && room.capacity >= requestedCapacity) {
    const waste = room.capacity - requestedCapacity;
    rightSized = 1 / (1 + waste / requestedCapacity);
    if (waste === 0) reasons.push(`exactly the right size (${room.capacity} seats)`);
    else if (waste <= 2) reasons.push(`close fit (${room.capacity} seats for ${requestedCapacity})`);
  }

  // --- Tidy fit --------------------------------------------------------
  // Flush against either end of the gap leaves the remainder contiguous and
  // therefore still bookable. Landing in the middle splits one usable gap
  // into two, and a leftover shorter than one slot is dead space.
  const leadIn = start.getTime() - gapStart.getTime();
  const leadOut = gapEnd.getTime() - end.getTime();
  const slotMs = slotMinutes * 60_000;

  // Tidiness is only meaningful against real bookings. On a wide-open day the
  // whole 07:00-19:00 window is one gap, so both 07:00 and 17:30 sit "flush"
  // against an edge — and rewarding that ranked a late-afternoon slot above a
  // morning one on the same empty day, which is backwards. A day boundary is
  // not a neighbour, so it earns neither the bonus nor the penalty.
  const flushAtStart = leadIn === 0 && gapStartIsBooking;
  const flushAtEnd = leadOut === 0 && gapEndIsBooking;
  const fragmentsStart = leadIn > 0 && gapStartIsBooking;
  const fragmentsEnd = leadOut > 0 && gapEndIsBooking;

  let tidyFit: number;
  if (flushAtStart && flushAtEnd) {
    tidyFit = 1;
    reasons.push("fills the free gap exactly");
  } else if (flushAtStart || flushAtEnd) {
    tidyFit = 0.85;
    reasons.push("sits flush against an existing booking, leaving the rest of the gap whole");
  } else if (fragmentsStart || fragmentsEnd) {
    // Splitting a real gap, and worse if it strands a sub-slot sliver.
    const slivers = [fragmentsStart ? leadIn : Infinity, fragmentsEnd ? leadOut : Infinity];
    tidyFit = Math.min(...slivers) < slotMs ? 0.2 : 0.5;
  } else {
    // No adjacent bookings at all: nothing to be tidy about either way.
    tidyFit = 0.7;
  }

  const score =
    WEIGHT.soonest * soonest + WEIGHT.rightSized * rightSized + WEIGHT.tidyFit * tidyFit;

  if (soonest > 0.9) reasons.unshift("one of the soonest openings");
  return { score: Math.round(score * 1000) / 1000, reasons };
}

function matchesRoom(room: Room, q: FindSlotsQuery): boolean {
  if (!room.online) return false;
  if (q.minCapacity !== undefined && room.capacity < q.minCapacity) return false;
  if (q.floor !== undefined && room.floor !== q.floor) return false;
  if (q.amenities && q.amenities.length > 0) {
    if (!q.amenities.every((a) => room.amenities.includes(a))) return false;
  }
  if (q.roomIds && q.roomIds.length > 0 && !q.roomIds.includes(room.id)) return false;
  return true;
}

/**
 * Why did nothing match? Re-runs the room filter with one constraint dropped
 * at a time to find the binding one, so callers can say "no camera rooms seat
 * 10" instead of an unhelpful empty list.
 */
function diagnoseNoMatch(rooms: Room[], q: FindSlotsQuery): string {
  const online = rooms.filter((r) => r.online);
  if (online.length === 0) return "No rooms are responding right now.";

  const relax = (over: Partial<FindSlotsQuery>) =>
    online.filter((r) => matchesRoom(r, { ...q, ...over })).length > 0;

  if (q.amenities && q.amenities.length > 0 && relax({ amenities: [] })) {
    return `No room with ${q.amenities.join(" + ")} is free for that long in this range.`;
  }
  if (q.minCapacity !== undefined && relax({ minCapacity: undefined })) {
    return `No room seating ${q.minCapacity} or more is free for that long in this range.`;
  }
  if (q.floor !== undefined && relax({ floor: undefined })) {
    return `Nothing on floor ${q.floor} is free for that long in this range.`;
  }
  if (online.filter((r) => matchesRoom(r, q)).length === 0) {
    return "No room matches those requirements at all, regardless of time.";
  }
  return `No ${q.durationMinutes}-minute opening in this range. Try a shorter meeting or a wider date range.`;
}

export async function findSlots(q: FindSlotsQuery): Promise<FindSlotsResult> {
  const availability = await getAvailability(q.from, q.to);
  const slotMinutes = availability.fleet.slotMinutes;
  const durationMs = q.durationMinutes * 60_000;
  const requestedCapacity = q.minCapacity ?? 0;

  // Never propose something already in the past.
  const now = new Date();
  const floorInstant = new Date(Math.max(q.from.getTime(), now.getTime()));

  const candidates: SlotCandidate[] = [];
  const allRooms = availability.rooms.map((r) => r.room);

  for (const entry of availability.rooms) {
    if (!matchesRoom(entry.room, q)) continue;

    // A gap edge that coincides with another booking's boundary is a real
    // neighbour; one that coincides with the bookable-day edge is not.
    const bookingEdges = new Set<number>();
    for (const b of entry.busy) {
      bookingEdges.add(parseClientDateTime(b.start).getTime());
      bookingEdges.add(parseClientDateTime(b.end).getTime());
    }

    for (const gap of entry.free) {
      // The relay's own availability output is offset-qualified ISO, which
      // parseClientDateTime handles directly -- no need to round-trip it back
      // through the appliance's format.
      const gapStart = parseClientDateTime(gap.start);
      const gapEnd = parseClientDateTime(gap.end);
      const gapStartIsBooking = bookingEdges.has(gapStart.getTime());
      const gapEndIsBooking = bookingEdges.has(gapEnd.getTime());

      // Earliest start we'd consider inside this gap, snapped to the grid.
      let cursor = new Date(Math.max(gapStart.getTime(), floorInstant.getTime()));
      cursor = ceilToSlot(cursor, slotMinutes);

      for (; cursor.getTime() + durationMs <= gapEnd.getTime(); cursor = addMinutes(cursor, slotMinutes)) {
        const end = new Date(cursor.getTime() + durationMs);

        const startHour = localParts(cursor).hour + localParts(cursor).minute / 60;
        const endHour = localParts(end).hour + localParts(end).minute / 60;
        if (q.earliestHour !== undefined && startHour < q.earliestHour) continue;
        // An end of exactly midnight reads as hour 0; treat it as end-of-day.
        const effectiveEndHour = endHour === 0 ? 24 : endHour;
        if (q.latestHour !== undefined && effectiveEndHour > q.latestHour) continue;

        const { score, reasons } = scoreSlot({
          start: cursor,
          end,
          room: entry.room,
          gapStart,
          gapEnd,
          gapStartIsBooking,
          gapEndIsBooking,
          rangeStart: floorInstant,
          rangeEnd: q.to,
          requestedCapacity,
          slotMinutes,
        });

        candidates.push({
          roomId: entry.room.id,
          roomName: entry.room.name,
          capacity: entry.room.capacity,
          floor: entry.room.floor,
          amenities: entry.room.amenities,
          start: toIso(cursor),
          end: toIso(end),
          score,
          reasons,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));

  const limit = q.limit ?? DEFAULT_LIMIT;
  const trimmed = diversify(candidates, limit);

  return {
    query: {
      from: toIso(q.from),
      to: toIso(q.to),
      durationMinutes: q.durationMinutes,
      earliestHour: q.earliestHour ?? null,
      latestHour: q.latestHour ?? null,
      minCapacity: q.minCapacity ?? null,
      amenities: q.amenities ?? [],
      floor: q.floor ?? null,
    },
    candidates: trimmed,
    totalFound: candidates.length,
    noMatchReason: candidates.length === 0 ? diagnoseNoMatch(allRooms, q) : null,
  };
}

/**
 * Trim to `limit` while keeping the shortlist genuinely varied.
 *
 * Both obvious keys produce a bad list, which is worth recording because the
 * failure is only visible against real data:
 *
 *   - Keying on room gives every room at the single earliest opening. On a
 *     quiet day that is six rooms at 7:00 — one option shown six times.
 *   - Keying on exact start time gives 7:00 / 7:15 / 7:30 in whichever room
 *     ranks best — three names for the same decision.
 *
 * Bucketing by hour is what actually reads as a set of alternatives: at most
 * one suggestion per room-hour, so distinct times come first and the same hour
 * can still offer a second room once the obvious times are covered.
 */
export function diversify(sorted: readonly SlotCandidate[], limit: number): SlotCandidate[] {
  const picked: SlotCandidate[] = [];
  const hourBucket = (c: SlotCandidate) => c.start.slice(0, 13); // YYYY-MM-DDTHH

  const seenHours = new Set<string>();
  const seenRooms = new Set<string>();
  const seenRoomHours = new Set<string>();

  const take = (c: SlotCandidate) => {
    seenHours.add(hourBucket(c));
    seenRooms.add(c.roomId);
    seenRoomHours.add(`${c.roomId}:${hourBucket(c)}`);
    picked.push(c);
  };

  // Pass 1: a new hour *and* a new room. On a quiet day every room is free
  // every hour, so requiring both is what stops the list being one room's
  // whole afternoon (which is what keying on hour alone produced).
  for (const c of sorted) {
    if (picked.length >= limit) break;
    if (seenHours.has(hourBucket(c)) || seenRooms.has(c.roomId)) continue;
    take(c);
  }

  // Pass 2: a new hour in a room already shown — a different time is still a
  // different choice once every room has had a turn.
  for (const c of sorted) {
    if (picked.length >= limit) break;
    if (seenHours.has(hourBucket(c))) continue;
    take(c);
  }

  // Pass 3: a new room inside an already-covered hour.
  for (const c of sorted) {
    if (picked.length >= limit) break;
    if (seenRooms.has(c.roomId)) continue;
    take(c);
  }

  // Pass 4: anything left that is not an exact room+hour repeat.
  for (const c of sorted) {
    if (picked.length >= limit) break;
    if (seenRoomHours.has(`${c.roomId}:${hourBucket(c)}`)) continue;
    take(c);
  }

  // The passes select for variety, not in score order, so a later pass can
  // append something that outranks an earlier pick. Re-sort before returning:
  // a list presented as ranked should actually be in rank order.
  return picked.sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));
}

/** Round an instant up to the next slot boundary (no-op if already on one). */
export function ceilToSlot(d: Instant, slotMinutes: number): Instant {
  const p = localParts(d);
  const minuteOfDay = p.hour * 60 + p.minute;
  const remainder = minuteOfDay % slotMinutes;
  if (remainder === 0 && p.second === 0) return d;
  return addMinutes(new Date(d.getTime() - p.second * 1000), slotMinutes - remainder);
}
