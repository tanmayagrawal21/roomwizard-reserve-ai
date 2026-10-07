/**
 * Date and time translation for RoomWizard appliances.
 *
 * The appliances use five different representations of the same concept:
 *
 *   - `20261007`             dates, in query params
 *   - `140000`              times, in query params (HHMMSS)
 *   - `2026/10/07 14:00:00`  timestamps, in JSON responses
 *   - `07` + `202610`        dates, split across two form selects (DD + YYYYMM)
 *   - `1800`                 rejected — BookingForm.action throws
 *                            `Unparseable date: "1800"`
 *
 * None of them carry a timezone. They are all wall-clock values in whatever
 * zone the appliance is installed in, so every conversion here needs the
 * configured IANA timezone (`RW_TIMEZONE`).
 *
 * Everything crossing the relay boundary is an ISO 8601 string with an explicit
 * offset instead. The offset is computed per-instant via `Intl`, so zones that
 * observe DST are handled correctly — the building this was developed against
 * is in America/Phoenix, which never shifts, but that must not be baked in.
 */

import { TIMEZONE } from "./config.ts";

/** An absolute moment in time. Wall-clock interpretation needs a timezone. */
export type Instant = Date;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * `Intl.DateTimeFormat` construction is expensive relative to how often we
 * convert, so formatters are memoized per timezone.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== "string") {
    // Almost always `arr.map(toIso)`: map passes the index as the second
    // argument, which lands in the timeZone slot. Say so, rather than
    // reporting a baffling "unknown timezone 0".
    throw new TypeError(
      `timeZone must be a string, got ${typeof timeZone} (${String(timeZone)}). ` +
        `If you wrote .map(toIso), use .map((d) => toIso(d)) — Array.map passes ` +
        `the index as a second argument.`,
    );
  }
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        era: "short",
      });
    } catch {
      throw new Error(
        `Unknown timezone ${JSON.stringify(timeZone)}. ` +
          `Set RW_TIMEZONE to an IANA name such as America/Phoenix.`,
      );
    }
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock fields for an instant in the given zone. */
export function localParts(d: Instant, timeZone: string = TIMEZONE): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(d);
  const get = (type: string) => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl did not return a ${type} part`);
    return Number(p.value);
  };
  // `hour12: false` can render midnight as 24; normalize it to 0.
  const hour = get("hour") % 24;
  const era = parts.find((p) => p.type === "era")?.value;
  const year = era === "BC" ? 1 - get("year") : get("year");
  return {
    year,
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Zone offset in minutes at a given instant (east of UTC is positive). */
export function offsetMinutesAt(d: Instant, timeZone: string = TIMEZONE): number {
  const p = localParts(d, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Discard sub-second noise so the result is a whole number of minutes.
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Build an instant from wall-clock fields in the given zone.
 *
 * Month/day/hour values outside their natural range roll over, matching
 * `Date.UTC` — `fromLocalParts(2026, 10, 32)` is 1 November. `addDays` relies
 * on this.
 *
 * DST makes this a fixed-point problem: the offset depends on the instant we
 * are trying to find. Two iterations converge for every real-world zone, since
 * transitions are at most a couple of hours and never adjacent.
 */
export function fromLocalParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  timeZone: string = TIMEZONE,
): Instant {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = target - offsetMinutesAt(new Date(target), timeZone) * 60_000;
  instant = target - offsetMinutesAt(new Date(instant), timeZone) * 60_000;
  return new Date(instant);
}

// ---------------------------------------------------------------------------
// Appliance -> relay
// ---------------------------------------------------------------------------

/**
 * Parse an appliance JSON timestamp (`2026/10/07 14:00:00`). These carry no
 * offset and are wall-clock time in the appliance's own zone.
 */
export function parseApplianceTimestamp(value: string, timeZone: string = TIMEZONE): Instant {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Unrecognized appliance timestamp: ${JSON.stringify(value)}`);
  const [, y, mo, d, h, mi, s] = m;
  return fromLocalParts(+y!, +mo!, +d!, +h!, +mi!, s ? +s : 0, timeZone);
}

/** Parse an appliance `YYYYMMDD` date into local midnight. */
export function parseApplianceDate(value: string, timeZone: string = TIMEZONE): Instant {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Unrecognized appliance date: ${JSON.stringify(value)}`);
  const [, y, mo, d] = m;
  return fromLocalParts(+y!, +mo!, +d!, 0, 0, 0, timeZone);
}

// ---------------------------------------------------------------------------
// Relay -> appliance
// ---------------------------------------------------------------------------

/** `20261007` — for Connector query params. */
export function toApplianceDate(d: Instant, timeZone: string = TIMEZONE): string {
  const p = localParts(d, timeZone);
  return `${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}`;
}

/** `140000` — for Connector query params and BookingForm selects. */
export function toApplianceTime(d: Instant, timeZone: string = TIMEZONE): string {
  const p = localParts(d, timeZone);
  return `${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
}

/** `{ day: "07", yearMonth: "202610" }` — for the split BookingForm selects. */
export function toFormDateParts(
  d: Instant,
  timeZone: string = TIMEZONE,
): { day: string; yearMonth: string } {
  const p = localParts(d, timeZone);
  return { day: pad(p.day), yearMonth: `${pad(p.year, 4)}${pad(p.month)}` };
}

// ---------------------------------------------------------------------------
// Relay -> client
// ---------------------------------------------------------------------------

/** `-07:00`, `+05:30`, `Z` — the zone's offset at this instant. */
export function offsetLabel(d: Instant, timeZone: string = TIMEZONE): string {
  const mins = offsetMinutesAt(d, timeZone);
  if (mins === 0) return "Z";
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** ISO 8601 with the zone's explicit offset, e.g. `2026-10-07T14:00:00-07:00`. */
export function toIso(d: Instant, timeZone: string = TIMEZONE): string {
  const p = localParts(d, timeZone);
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetLabel(d, timeZone)}`
  );
}

/** `2026-10-07` in local terms. */
export function toIsoDate(d: Instant, timeZone: string = TIMEZONE): string {
  const p = localParts(d, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

// ---------------------------------------------------------------------------
// Client -> relay
// ---------------------------------------------------------------------------

/**
 * Accept what a browser or an LLM tool call is likely to send: a bare local
 * date (`2026-10-07`), a local datetime with no offset (treated as building
 * local time), or a fully-qualified ISO string with an offset or `Z`.
 */
export function parseClientDateTime(value: string, timeZone: string = TIMEZONE): Instant {
  const v = value.trim();

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return fromLocalParts(+y!, +mo!, +d!, 0, 0, 0, timeZone);
  }

  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (naive) {
    const [, y, mo, d, h, mi, s] = naive;
    return fromLocalParts(+y!, +mo!, +d!, +h!, +mi!, s ? +s : 0, timeZone);
  }

  const qualified = new Date(v);
  if (Number.isNaN(qualified.getTime())) {
    throw new Error(`Unrecognized date/time: ${JSON.stringify(value)}`);
  }
  return qualified;
}

// ---------------------------------------------------------------------------
// Arithmetic helpers
// ---------------------------------------------------------------------------

export const addMinutes = (d: Instant, minutes: number): Instant =>
  new Date(d.getTime() + minutes * 60_000);

/**
 * Add calendar days in local terms. Not the same as adding 24h: across a DST
 * transition the elapsed time differs, and the wall-clock time is what callers
 * mean when they say "tomorrow at 9".
 */
export const addDays = (d: Instant, days: number, timeZone: string = TIMEZONE): Instant => {
  const p = localParts(d, timeZone);
  return fromLocalParts(p.year, p.month, p.day + days, p.hour, p.minute, p.second, timeZone);
};

/** Local midnight on the same calendar day. */
export const startOfLocalDay = (d: Instant, timeZone: string = TIMEZONE): Instant => {
  const p = localParts(d, timeZone);
  return fromLocalParts(p.year, p.month, p.day, 0, 0, 0, timeZone);
};

export const localHour = (d: Instant, timeZone: string = TIMEZONE): number =>
  localParts(d, timeZone).hour;

/**
 * Set the local wall-clock time on the same calendar day. An hour of 24 means
 * midnight at the end of that day, which is how the appliances express a
 * timeline that runs to the end of the day.
 */
export function atLocalTime(
  d: Instant,
  hour: number,
  minute = 0,
  timeZone: string = TIMEZONE,
): Instant {
  const p = localParts(d, timeZone);
  return fromLocalParts(p.year, p.month, p.day, hour, minute, 0, timeZone);
}

/** Inclusive list of local midnights spanning `from`..`to`. */
export function eachLocalDay(
  from: Instant,
  to: Instant,
  timeZone: string = TIMEZONE,
): Instant[] {
  const days: Instant[] = [];
  let cursor = startOfLocalDay(from, timeZone);
  const last = startOfLocalDay(to, timeZone);
  // Guard against a pathological range producing an unbounded loop.
  for (let i = 0; cursor.getTime() <= last.getTime() && i < 400; i++) {
    days.push(cursor);
    cursor = addDays(cursor, 1, timeZone);
  }
  return days;
}
