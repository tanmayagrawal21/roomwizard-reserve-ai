import { describe, expect, it } from "vitest";
import bookings258 from "./fixtures/bookings-258.json" with { type: "json" };
import {
  computeFree,
  mergeIntervals,
  normalizeBooking,
  overlapsRange,
  type TimedBooking,
} from "../src/availability.ts";
import type { RawBooking } from "../src/roomwizard.ts";
import { fromLocalParts, toIso } from "../src/time.ts";

const raw = bookings258 as unknown as RawBooking[];
const timed = raw
  .map((b) => normalizeBooking(b, "bsrl-258"))
  .filter((b): b is TimedBooking => b !== null);

const at = (h: number, m = 0) => fromLocalParts(2026, 10, 8, h, m);
const spans = (intervals: { start: Date; end: Date }[]) =>
  intervals.map((i) => `${toIso(i.start).slice(11, 16)}-${toIso(i.end).slice(11, 16)}`);

describe("normalizeBooking", () => {
  it("never leaks the password hash", () => {
    // The appliance includes booking credential material in its responses.
    // Re-publishing it through our own API would widen the exposure.
    for (const t of timed) {
      expect(JSON.stringify(t.booking)).not.toContain("beef");
      expect(JSON.stringify(t.booking)).not.toContain("cafe");
      expect(t.booking).not.toHaveProperty("password");
    }
  });

  it("converts timestamps to ISO with the Phoenix offset", () => {
    const b = timed[0]!.booking;
    expect(b.start).toBe("2026-10-08T09:00:00-07:00");
    expect(b.end).toBe("2026-10-08T10:30:00-07:00");
    expect(b.createdAt).toBe("2026-10-06T11:30:54-07:00");
  });

  it("joins the host name", () => {
    expect(timed[0]!.booking.host).toBe("Sam Rivera");
  });

  it("withholds subject and host for a confidential booking but keeps the time", () => {
    const b = timed.find((t) => t.booking.id === "9002")!.booking;
    expect(b.isConfidential).toBe(true);
    expect(b.purpose).toBeNull();
    expect(b.host).toBeNull();
    // The slot is still blocked, which is the part availability depends on.
    expect(b.start).toBe("2026-10-08T13:00:00-07:00");
  });

  it("drops a booking whose timestamps cannot be parsed", () => {
    // Keeping it would silently distort the free/busy map.
    expect(normalizeBooking(raw.find((b) => b.Id === "9004")!, "bsrl-258")).toBeNull();
    expect(timed.map((t) => t.booking.id)).not.toContain("9004");
  });
});

describe("mergeIntervals", () => {
  it("merges overlapping ranges", () => {
    expect(
      spans(mergeIntervals([
        { start: at(13), end: at(14) },
        { start: at(13, 30), end: at(15) },
      ])),
    ).toEqual(["13:00-15:00"]);
  });

  it("merges exactly-adjacent ranges", () => {
    expect(
      spans(mergeIntervals([
        { start: at(9), end: at(10) },
        { start: at(10), end: at(11) },
      ])),
    ).toEqual(["09:00-11:00"]);
  });

  it("keeps disjoint ranges separate and sorted", () => {
    expect(
      spans(mergeIntervals([
        { start: at(15), end: at(16) },
        { start: at(9), end: at(10) },
      ])),
    ).toEqual(["09:00-10:00", "15:00-16:00"]);
  });

  it("swallows a range fully contained in another", () => {
    expect(
      spans(mergeIntervals([
        { start: at(9), end: at(17) },
        { start: at(12), end: at(13) },
      ])),
    ).toEqual(["09:00-17:00"]);
  });

  it("discards zero-length and inverted ranges", () => {
    expect(mergeIntervals([{ start: at(9), end: at(9) }])).toEqual([]);
    expect(mergeIntervals([{ start: at(11), end: at(9) }])).toEqual([]);
  });
});

describe("computeFree", () => {
  it("returns the whole bookable window when nothing is booked", () => {
    expect(spans(computeFree([], at(0), fromLocalParts(2026, 10, 9), 7, 19))).toEqual([
      "07:00-19:00",
    ]);
  });

  it("never reports hours outside the bookable window as free", () => {
    // Range spans the full calendar day, but 07:00-19:00 is all that is bookable.
    const free = computeFree([], at(0), fromLocalParts(2026, 10, 9), 7, 19);
    expect(free).toHaveLength(1);
    expect(toIso(free[0]!.start)).toBe("2026-10-08T07:00:00-07:00");
    expect(toIso(free[0]!.end)).toBe("2026-10-08T19:00:00-07:00");
  });

  it("carves gaps around the fixture's bookings", () => {
    // 09:00-10:30 busy, then 13:00-15:00 busy (two overlapping bookings merged).
    expect(spans(computeFree(timed, at(0), fromLocalParts(2026, 10, 9), 7, 19))).toEqual([
      "07:00-09:00",
      "10:30-13:00",
      "15:00-19:00",
    ]);
  });

  it("clips free windows to a narrower requested range", () => {
    expect(spans(computeFree(timed, at(10), at(14), 7, 19))).toEqual(["10:30-13:00"]);
  });

  it("produces nothing when the room is booked solid", () => {
    const solid = [{ start: at(7), end: at(19) }];
    expect(computeFree(solid, at(0), fromLocalParts(2026, 10, 9), 7, 19)).toEqual([]);
  });

  it("spans multiple days, resetting the window each day", () => {
    const busy = [{ start: at(9), end: at(10) }];
    // Oct 8 00:00 -> Oct 11 00:00 covers two full bookable days after the 8th.
    expect(
      spans(computeFree(busy, at(0), fromLocalParts(2026, 10, 11), 7, 19)),
    ).toEqual([
      "07:00-09:00",
      "10:00-19:00",
      // Oct 9 and Oct 10 are untouched by the booking.
      "07:00-19:00",
      "07:00-19:00",
    ]);
  });

  it("treats the range end as exclusive", () => {
    // A range ending at Oct 10 00:00 contains no bookable time on Oct 10, so
    // that day contributes nothing rather than a spurious full-day window.
    const free = computeFree([], at(0), fromLocalParts(2026, 10, 10), 7, 19);
    expect(spans(free)).toEqual(["07:00-19:00", "07:00-19:00"]);
  });

  it("ignores a booking that falls entirely outside the window", () => {
    const busy = [{ start: at(5), end: at(6) }];
    expect(spans(computeFree(busy, at(0), fromLocalParts(2026, 10, 9), 7, 19))).toEqual([
      "07:00-19:00",
    ]);
  });

  it("handles a booking that straddles the window start", () => {
    const busy = [{ start: at(6), end: at(8) }];
    expect(spans(computeFree(busy, at(0), fromLocalParts(2026, 10, 9), 7, 19))).toEqual([
      "08:00-19:00",
    ]);
  });

  it("handles a day-end hour of 24", () => {
    const free = computeFree([], at(0), fromLocalParts(2026, 10, 9), 7, 24);
    expect(spans(free)).toEqual(["07:00-00:00"]);
    expect(toIso(free[0]!.end)).toBe("2026-10-09T00:00:00-07:00");
  });
});

describe("overlapsRange", () => {
  // The Connector ignores the time parts of its range params and returns whole
  // days, so the relay has to do this filtering itself.
  const from = at(9);
  const to = at(12);

  it("keeps a booking fully inside the window", () => {
    expect(overlapsRange({ start: at(10), end: at(11) }, from, to)).toBe(true);
  });

  it("keeps a booking that straddles either edge", () => {
    expect(overlapsRange({ start: at(8), end: at(10) }, from, to)).toBe(true);
    expect(overlapsRange({ start: at(11), end: at(13) }, from, to)).toBe(true);
  });

  it("keeps a booking that spans the whole window", () => {
    expect(overlapsRange({ start: at(7), end: at(19) }, from, to)).toBe(true);
  });

  it("drops a booking entirely before or after", () => {
    expect(overlapsRange({ start: at(7), end: at(8) }, from, to)).toBe(false);
    expect(overlapsRange({ start: at(13), end: at(14) }, from, to)).toBe(false);
  });

  it("treats the boundaries as half-open", () => {
    // Ends exactly at `from`: not in range. Starts exactly at `to`: not in range.
    expect(overlapsRange({ start: at(8), end: at(9) }, from, to)).toBe(false);
    expect(overlapsRange({ start: at(12), end: at(13) }, from, to)).toBe(false);
    // Starts exactly at `from`: in range.
    expect(overlapsRange({ start: at(9), end: at(10) }, from, to)).toBe(true);
  });

  it("drops a next-day booking from a single-day request", () => {
    const dayFrom = fromLocalParts(2026, 10, 8);
    const dayTo = fromLocalParts(2026, 10, 9);
    const nextDay = { start: fromLocalParts(2026, 10, 9, 11), end: fromLocalParts(2026, 10, 9, 12) };
    expect(overlapsRange(nextDay, dayFrom, dayTo)).toBe(false);
  });
});
