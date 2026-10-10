import { describe, expect, it } from "vitest";
import { allowedDurations, allowedEndMinutes, latestEndMinute, type EndTimeLimits } from "./slots";

const H = (h: number, m = 0) => h * 60 + m;

/** 7:00-19:00 bookable, 15-minute slots, 8h cap, nothing booked. */
function limits(over: Partial<EndTimeLimits> = {}): EndTimeLimits {
  return {
    startMinute: H(9),
    dayEndHour: 19,
    slotMinutes: 15,
    maxBookingHours: 8,
    busy: [],
    ...over,
  };
}

describe("latestEndMinute", () => {
  it("is capped by the end of the bookable day", () => {
    // 17:00 start, 8h cap would allow 01:00, but the day ends at 19:00.
    expect(latestEndMinute(limits({ startMinute: H(17) }))).toBe(H(19));
  });

  it("is capped by the max-booking policy", () => {
    // 7:00 start: 8h cap lands at 15:00, well before the 19:00 day end.
    expect(latestEndMinute(limits({ startMinute: H(7) }))).toBe(H(15));
  });

  it("is capped by the next booking in the room", () => {
    expect(
      latestEndMinute(
        limits({ startMinute: H(9), busy: [{ startMinute: H(10), endMinute: H(11) }] }),
      ),
    ).toBe(H(10));
  });

  it("picks the nearest of several following bookings", () => {
    expect(
      latestEndMinute(
        limits({
          startMinute: H(9),
          busy: [
            { startMinute: H(14), endMinute: H(15) },
            { startMinute: H(11, 30), endMinute: H(12) },
            { startMinute: H(16), endMinute: H(17) },
          ],
        }),
      ),
    ).toBe(H(11, 30));
  });

  it("ignores bookings that already ended before the start", () => {
    expect(
      latestEndMinute(
        limits({ startMinute: H(9), busy: [{ startMinute: H(7), endMinute: H(8) }] }),
      ),
    ).toBe(H(17));
  });

  it("ignores a booking ending exactly at our start", () => {
    // Back-to-back is legal; 8:00-9:00 must not cap a 9:00 start.
    expect(
      latestEndMinute(
        limits({ startMinute: H(9), busy: [{ startMinute: H(8), endMinute: H(9) }] }),
      ),
    ).toBe(H(17));
  });

  it("never returns a time before the start", () => {
    // A start right at the day end leaves no room at all.
    expect(latestEndMinute(limits({ startMinute: H(19) }))).toBe(H(19));
  });
});

describe("allowedEndMinutes", () => {
  it("steps by the slot size and excludes the start itself", () => {
    const ends = allowedEndMinutes(limits({ startMinute: H(9), busy: [{ startMinute: H(10), endMinute: H(11) }] }));
    expect(ends).toEqual([H(9, 15), H(9, 30), H(9, 45), H(10)]);
  });

  it("includes the next booking's start, so back-to-back is offered", () => {
    const ends = allowedEndMinutes(limits({ startMinute: H(9), busy: [{ startMinute: H(9, 30), endMinute: H(10) }] }));
    expect(ends).toEqual([H(9, 15), H(9, 30)]);
  });

  it("is empty when there is no room to book", () => {
    expect(allowedEndMinutes(limits({ startMinute: H(19) }))).toEqual([]);
  });

  it("snaps an off-grid start up to the slot grid", () => {
    // An existing booking edited to start at 9:07 should still only offer
    // on-grid end times, not 9:22 / 9:37 / ...
    const ends = allowedEndMinutes(
      limits({ startMinute: H(9, 7), busy: [{ startMinute: H(10), endMinute: H(11) }] }),
    );
    expect(ends).toEqual([H(9, 15), H(9, 30), H(9, 45), H(10)]);
  });

  it("respects a non-15-minute slot size", () => {
    const ends = allowedEndMinutes(
      limits({ startMinute: H(9), slotMinutes: 30, busy: [{ startMinute: H(10, 30), endMinute: H(11) }] }),
    );
    expect(ends).toEqual([H(9, 30), H(10), H(10, 30)]);
  });
});

describe("allowedDurations", () => {
  const PREFERRED = [15, 30, 45, 60, 90, 120];

  it("drops durations that would overrun the next booking", () => {
    expect(
      allowedDurations(
        limits({ startMinute: H(9), busy: [{ startMinute: H(10), endMinute: H(11) }] }),
        PREFERRED,
      ),
    ).toEqual([15, 30, 45, 60]);
  });

  it("keeps everything when the day is wide open", () => {
    expect(allowedDurations(limits({ startMinute: H(9) }), PREFERRED)).toEqual(PREFERRED);
  });

  it("drops durations that would run past the end of the day", () => {
    expect(allowedDurations(limits({ startMinute: H(18, 30) }), PREFERRED)).toEqual([15, 30]);
  });

  it("returns nothing when no duration fits", () => {
    expect(allowedDurations(limits({ startMinute: H(19) }), PREFERRED)).toEqual([]);
  });
});
