/**
 * Roster normalization.
 *
 * Turns the appliance's `buddyList` into something a UI can filter on. The two
 * useful derivations are a floor number (parsed out of free-text `location`)
 * and equipment tags (parsed out of free-text `facilities`) — neither exists as
 * a structured field, but both are what people actually filter by.
 */

import {
  CACHE_TTL_MS,
  DEFAULT_DAY_END_HOUR,
  DEFAULT_DAY_START_HOUR,
  ROSTER_HOST,
  SITE_NAME,
  SLOT_MINUTES,
  TIMEZONE,
} from "./config.ts";
import { TtlCache } from "./cache.ts";
import { fetchRoster, type RawBuddy, type RawRoster } from "./roomwizard.ts";
import { parseApplianceTimestamp, toIso, type Instant } from "./time.ts";

export type Amenity = "camera" | "pc" | "cisco_vc" | "audio_conf";

export interface Room {
  /** Stable id used in URLs and tool calls, e.g. `bsrl-203`. */
  id: string;
  name: string;
  host: string;
  capacity: number;
  /** Parsed from `location` where possible; null when it cannot be inferred. */
  floor: number | null;
  location: string;
  amenities: Amenity[];
  /** Original free-text, kept for display. */
  facilities: string;
  /** False when the roster itself reported the appliance as unreachable. */
  online: boolean;
  isPrivate: boolean;
}

export interface Fleet {
  /** Label for the installation, e.g. "BSRL". */
  site: string;
  rooms: Room[];
  /** Bookable window, local wall-clock hours, inclusive start / exclusive end. */
  dayStartHour: number;
  dayEndHour: number;
  slotMinutes: number;
  timezone: string;
  /** The appliance's own clock, useful for spotting drift. */
  applianceTime: string | null;
}

/** `https://bsrl-203.arizona.edu/` -> `bsrl-203` */
export function roomIdFromHost(host: string): string {
  try {
    return new URL(host).hostname.split(".")[0]!.toLowerCase();
  } catch {
    return host.replace(/^https?:\/\//, "").split(".")[0]!.toLowerCase();
  }
}

const ORDINAL_FLOORS: [RegExp, number][] = [
  [/\b(?:1st|first)\b/i, 1],
  [/\b(?:2nd|second)\b/i, 2],
  [/\b(?:3rd|third)\b/i, 3],
  [/\b(?:4th|fourth)\b/i, 4],
  [/\b(?:5th|fifth)\b/i, 5],
];

/**
 * Infer a floor number.
 *
 * Prefers the room number, because "first digit(s) are the floor" is close to
 * universal in building numbering and more reliable than prose: BSRL-203 -> 2,
 * 1203 -> 12. Falls back to ordinals in `location` ("3rd Floor North") for
 * rooms that are named rather than numbered.
 *
 * Returns null rather than guessing when neither signal is present — the UI
 * shows "floor unknown", which is honest and better than a wrong filter.
 */
export function inferFloor(roomName: string, location: string): number | null {
  const num = /(\d{3,4})\s*$/.exec(roomName.trim());
  if (num) {
    const floor = Math.floor(Number(num[1]) / 100);
    // Floor 0 means a sub-100 room number, which does not encode a floor.
    if (floor >= 1 && floor <= 99) return floor;
  }
  for (const [pattern, floor] of ORDINAL_FLOORS) {
    if (pattern.test(location)) return floor;
  }
  return null;
}

/** Tag equipment from the free-text facilities blurb. */
export function inferAmenities(facilities: string): Amenity[] {
  const f = facilities.toLowerCase();
  const tags: Amenity[] = [];
  if (/camera|ptz|pan tilt zoom/.test(f)) tags.push("camera");
  if (/\bpc\b|windows/.test(f)) tags.push("pc");
  if (/cisco/.test(f)) tags.push("cisco_vc");
  if (/audio conferencing/.test(f)) tags.push("audio_conf");
  return tags;
}

export function normalizeBuddy(buddy: RawBuddy): Room {
  const facilities = (buddy.facilities ?? "").trim();
  const location = (buddy.location ?? "").trim();
  return {
    id: roomIdFromHost(buddy.host),
    name: buddy.roomName,
    host: buddy.host,
    capacity: Number(buddy.capacity) || 0,
    floor: inferFloor(buddy.roomName, location),
    location,
    amenities: inferAmenities(facilities),
    facilities,
    online: buddy.success !== false,
    isPrivate: buddy.isPrivateRoom === true,
  };
}

/** Clamp an appliance timeline bound (`"07"`, `"19"`, `"00"`) to an hour. */
function parseTimelineHour(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 24) return fallback;
  // The appliance reports a midnight end as "00"; treat it as 24.
  return n === 0 ? 24 : n;
}

export function normalizeRoster(roster: RawRoster): Fleet {
  const rooms = (roster.buddyList ?? [])
    .map(normalizeBuddy)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

  let applianceTime: string | null = null;
  try {
    if (roster.currentTime) {
      applianceTime = toIso(parseApplianceTimestamp(roster.currentTime));
    }
  } catch {
    // A malformed clock is not worth failing the whole roster over.
  }

  return {
    site: SITE_NAME,
    rooms,
    dayStartHour: parseTimelineHour(roster.timelineStart, DEFAULT_DAY_START_HOUR),
    dayEndHour: parseTimelineHour(roster.timelineEnd, DEFAULT_DAY_END_HOUR),
    slotMinutes: Number(roster.defaultBookingLength) || SLOT_MINUTES,
    timezone: TIMEZONE,
    applianceTime,
  };
}

const fleetCache = new TtlCache<Fleet>(CACHE_TTL_MS.rooms);

export async function getFleet(on: Instant): Promise<Fleet> {
  return fleetCache.fetch("fleet", async () => {
    const roster = await fetchRoster(ROSTER_HOST, on);
    return normalizeRoster(roster);
  });
}

export function invalidateFleet(): void {
  fleetCache.invalidate("fleet");
}
