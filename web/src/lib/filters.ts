/**
 * Room filtering and derived stats.
 *
 * Kept out of the components because these are also exactly the operations the
 * Phase 4 slot finder and the Phase 5 LLM tools need. Deciding "which rooms
 * match" in one place means the chat and the picker can never disagree.
 */

import type { Amenity, RoomAvailability } from "../api";

export interface Filters {
  minCapacity: number;
  amenities: Amenity[];
  floor: number | null;
  /** Only rooms with a free gap at least this long, in minutes. 0 disables. */
  minFreeMinutes: number;
}

export const EMPTY_FILTERS: Filters = {
  minCapacity: 0,
  amenities: [],
  floor: null,
  minFreeMinutes: 0,
};

export const AMENITY_LABELS: Record<Amenity, string> = {
  camera: "Camera",
  pc: "In-room PC",
  cisco_vc: "Cisco VC",
  audio_conf: "Audio conf",
};

export function longestFreeMinutes(entry: RoomAvailability): number {
  let longest = 0;
  for (const gap of entry.free) {
    const mins = (new Date(gap.end).getTime() - new Date(gap.start).getTime()) / 60_000;
    if (mins > longest) longest = mins;
  }
  return Math.round(longest);
}

export function matchesFilters(entry: RoomAvailability, f: Filters): boolean {
  const { room } = entry;
  if (room.capacity < f.minCapacity) return false;
  if (f.floor !== null && room.floor !== f.floor) return false;
  // Every selected amenity must be present, not any — "camera AND pc" is what
  // someone ticking both boxes means.
  if (!f.amenities.every((a) => room.amenities.includes(a))) return false;
  if (f.minFreeMinutes > 0 && longestFreeMinutes(entry) < f.minFreeMinutes) return false;
  return true;
}

export function activeFilterCount(f: Filters): number {
  return (
    (f.minCapacity > 0 ? 1 : 0) +
    (f.floor !== null ? 1 : 0) +
    f.amenities.length +
    (f.minFreeMinutes > 0 ? 1 : 0)
  );
}

/** Fraction of the bookable day that is booked, for the week strip heatmap. */
export function dayUtilization(
  entries: RoomAvailability[],
  dayStartHour: number,
  dayEndHour: number,
): number {
  if (entries.length === 0) return 0;
  const windowMinutes = (dayEndHour - dayStartHour) * 60;
  if (windowMinutes <= 0) return 0;

  let busyMinutes = 0;
  for (const entry of entries) {
    // `free` is already merged and clipped to bookable hours by the relay, so
    // deriving busy from it avoids double-counting overlapping bookings.
    const freeMinutes = entry.free.reduce(
      (sum, g) => sum + (new Date(g.end).getTime() - new Date(g.start).getTime()) / 60_000,
      0,
    );
    busyMinutes += Math.max(0, windowMinutes - freeMinutes);
  }
  return Math.min(1, busyMinutes / (windowMinutes * entries.length));
}
