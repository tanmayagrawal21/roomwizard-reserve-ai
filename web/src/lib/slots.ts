/**
 * Which end times a booking may actually have.
 *
 * Four separate ceilings apply, and the UI should only ever offer times that
 * clear all of them — otherwise picking one earns a 400 or 409 from the relay
 * after the fact, which is a worse experience than not offering it:
 *
 *   1. the end of the bookable day (`dayEndHour`)
 *   2. the relay's longest-booking policy (`maxBookingHours`)
 *   3. the start of the next existing booking in that room
 *   4. slot granularity (`slotMinutes`)
 *
 * (3) is the one the duration chips originally got wrong: clicking 7:00 in a
 * room with an 8:00 meeting still offered a 2h chip, which the relay would
 * then reject as a conflict.
 */

export interface EndTimeLimits {
  /** Minutes from local midnight where the booking starts. */
  startMinute: number;
  dayEndHour: number;
  slotMinutes: number;
  maxBookingHours: number;
  /**
   * Busy intervals in the same room on the same day, as minutes from local
   * midnight. Need not be sorted or disjoint.
   */
  busy: { startMinute: number; endMinute: number }[];
}

/**
 * The latest minute-of-day this booking may end at, respecting every ceiling.
 * Returns `startMinute` itself when nothing is bookable at all (the caller
 * should treat that as "no room here").
 */
export function latestEndMinute(limits: EndTimeLimits): number {
  const { startMinute, dayEndHour, maxBookingHours, busy } = limits;

  const ceilings = [dayEndHour * 60, startMinute + maxBookingHours * 60];

  // The next booking that begins at or after our start. A booking that merely
  // *contains* our start would mean the slot wasn't free to begin with, which
  // the picker prevents, but clamp to its start anyway rather than trusting it.
  for (const b of busy) {
    if (b.endMinute > startMinute && b.startMinute >= startMinute) {
      ceilings.push(b.startMinute);
    }
  }

  return Math.max(startMinute, Math.min(...ceilings));
}

/**
 * Every selectable end time, at slot granularity, from one slot after the
 * start through `latestEndMinute`. Ascending; empty when nothing fits.
 */
export function allowedEndMinutes(limits: EndTimeLimits): number[] {
  const { startMinute, slotMinutes } = limits;
  const latest = latestEndMinute(limits);
  const out: number[] = [];
  // Start at the first whole slot boundary after `startMinute` so a start that
  // is itself off-grid (an edited booking, say) still yields on-grid ends.
  let first = Math.ceil((startMinute + 1) / slotMinutes) * slotMinutes;
  if (first === startMinute) first += slotMinutes;
  for (let m = first; m <= latest; m += slotMinutes) out.push(m);
  return out;
}

/** The subset of `preferred` durations that fit, in minutes. */
export function allowedDurations(limits: EndTimeLimits, preferred: readonly number[]): number[] {
  const headroom = latestEndMinute(limits) - limits.startMinute;
  return preferred.filter((d) => d <= headroom);
}
