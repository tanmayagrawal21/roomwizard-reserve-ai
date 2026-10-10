import { describe, expect, it } from "vitest";
import { ceilToSlot, diversify, scoreSlot, type SlotCandidate } from "../src/slots.ts";
import type { Room } from "../src/rooms.ts";
import { fromLocalParts, toIso } from "../src/time.ts";

function room(over: Partial<Room> = {}): Room {
  return {
    id: "bsrl-203",
    name: "BSRL-203",
    host: "https://bsrl-203.arizona.edu/",
    capacity: 8,
    floor: 2,
    location: "",
    amenities: [],
    facilities: "",
    online: true,
    isPrivate: false,
    ...over,
  };
}

const at = (h: number, m = 0) => fromLocalParts(2026, 10, 12, h, m);

/** A 9:00-10:00 candidate inside a 9:00-11:00 gap, in a day spanning 7:00-19:00. */
function base(over: Partial<Parameters<typeof scoreSlot>[0]> = {}) {
  return {
    start: at(9),
    end: at(10),
    room: room(),
    gapStart: at(9),
    gapEnd: at(11),
    gapStartIsBooking: true,
    gapEndIsBooking: true,
    rangeStart: at(7),
    rangeEnd: at(19),
    requestedCapacity: 0,
    slotMinutes: 15,
    ...over,
  };
}

describe("scoreSlot: sooner is better", () => {
  it("ranks an earlier start above a later one, all else equal", () => {
    const early = scoreSlot(base({ start: at(8), end: at(9), gapStart: at(8), gapEnd: at(10) }));
    const late = scoreSlot(base({ start: at(16), end: at(17), gapStart: at(16), gapEnd: at(18) }));
    expect(early.score).toBeGreaterThan(late.score);
  });

  it("flags the very soonest openings in its reasons", () => {
    const soonest = scoreSlot(base({ start: at(7), end: at(8), gapStart: at(7), gapEnd: at(9) }));
    expect(soonest.reasons).toContain("one of the soonest openings");
  });
});

describe("scoreSlot: right-sized rooms", () => {
  it("prefers a room that matches the headcount over an oversized one", () => {
    const exact = scoreSlot(base({ room: room({ capacity: 6 }), requestedCapacity: 6 }));
    const oversized = scoreSlot(base({ room: room({ capacity: 20 }), requestedCapacity: 6 }));
    expect(exact.score).toBeGreaterThan(oversized.score);
  });

  it("says so when the fit is exact", () => {
    const exact = scoreSlot(base({ room: room({ capacity: 6 }), requestedCapacity: 6 }));
    expect(exact.reasons.join(" ")).toContain("exactly the right size");
  });

  it("describes a near fit without claiming it is exact", () => {
    const near = scoreSlot(base({ room: room({ capacity: 8 }), requestedCapacity: 6 }));
    expect(near.reasons.join(" ")).toContain("close fit");
    expect(near.reasons.join(" ")).not.toContain("exactly");
  });

  it("does not penalize room size when no headcount was given", () => {
    const small = scoreSlot(base({ room: room({ capacity: 8 }), requestedCapacity: 0 }));
    const big = scoreSlot(base({ room: room({ capacity: 20 }), requestedCapacity: 0 }));
    expect(small.score).toBe(big.score);
  });
});

describe("scoreSlot: tidy placement", () => {
  it("rates filling a gap exactly highest", () => {
    const exact = scoreSlot(base({ start: at(9), end: at(10), gapStart: at(9), gapEnd: at(10) }));
    expect(exact.reasons).toContain("fills the free gap exactly");
  });

  it("prefers flush-against-an-edge over landing mid-gap", () => {
    // Same start time, so only the tidy-fit term differs.
    const flush = scoreSlot(base({ start: at(9), end: at(10), gapStart: at(9), gapEnd: at(12) }));
    const middle = scoreSlot(base({ start: at(9), end: at(10), gapStart: at(7), gapEnd: at(12) }));
    expect(flush.score).toBeGreaterThan(middle.score);
    expect(flush.reasons.join(" ")).toContain("leaving the rest of the gap whole");
  });

  it("does not claim adjacency when the gap edge is just the start of the day", () => {
    // 7:00 on an empty day is flush against the bookable-day edge, not against
    // a meeting. Saying "sits flush against an existing booking" there is a
    // lie, and it showed up on real data for every room on a free Saturday.
    const dayEdge = scoreSlot(
      base({
        start: at(7),
        end: at(8),
        gapStart: at(7),
        gapEnd: at(19),
        gapStartIsBooking: false,
        gapEndIsBooking: false,
      }),
    );
    expect(dayEdge.reasons.join(" ")).not.toContain("existing booking");
    expect(dayEdge.reasons.join(" ")).not.toContain("fills the free gap exactly");
  });

  it("still scores a day-edge placement as tidy even without the note", () => {
    const dayEdge = scoreSlot(
      base({ start: at(7), end: at(8), gapStart: at(7), gapEnd: at(19), gapStartIsBooking: false, gapEndIsBooking: false }),
    );
    const midGap = scoreSlot(
      base({ start: at(9), end: at(10), gapStart: at(7), gapEnd: at(19), gapStartIsBooking: false, gapEndIsBooking: false }),
    );
    // Flush beats mid-gap on tidiness regardless of what bounds the gap.
    expect(dayEdge.score).toBeGreaterThan(midGap.score);
  });

  it("penalizes carving an unusable sliver off one side", () => {
    // 10-minute lead-in is shorter than one 15-minute slot: dead space.
    const sliver = scoreSlot(
      base({ start: at(9, 10), end: at(10, 10), gapStart: at(9), gapEnd: at(12) }),
    );
    const clean = scoreSlot(base({ start: at(9, 30), end: at(10, 30), gapStart: at(9), gapEnd: at(12) }));
    expect(clean.score).toBeGreaterThan(sliver.score);
  });
});

describe("scoreSlot: bounds", () => {
  it("always returns a score between 0 and 1", () => {
    for (const h of [7, 9, 12, 15, 18]) {
      for (const cap of [0, 1, 6, 20]) {
        const { score } = scoreSlot(base({ start: at(h), end: at(h + 1), requestedCapacity: cap }));
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("ceilToSlot", () => {
  it("leaves an on-grid instant alone", () => {
    expect(toIso(ceilToSlot(at(9, 30), 15))).toBe(toIso(at(9, 30)));
  });

  it("rounds up to the next boundary", () => {
    expect(toIso(ceilToSlot(at(9, 7), 15))).toBe(toIso(at(9, 15)));
    expect(toIso(ceilToSlot(at(9, 16), 15))).toBe(toIso(at(9, 30)));
  });

  it("rounds up across an hour boundary", () => {
    expect(toIso(ceilToSlot(at(9, 52), 15))).toBe(toIso(at(10, 0)));
  });

  it("honours a different slot size", () => {
    expect(toIso(ceilToSlot(at(9, 5), 30))).toBe(toIso(at(9, 30)));
  });

  it("discards stray seconds rather than rounding an extra slot", () => {
    const withSeconds = fromLocalParts(2026, 10, 12, 9, 0, 30);
    expect(toIso(ceilToSlot(withSeconds, 15))).toBe(toIso(at(9, 15)));
  });
});

describe("diversify", () => {
  const candidate = (roomId: string, start: string, score: number): SlotCandidate => ({
    roomId,
    roomName: roomId.toUpperCase(),
    capacity: 8,
    floor: 2,
    amenities: [],
    start,
    end: start,
    score,
    reasons: [],
  });

  it("collapses one room's 15-minute increments into a single suggestion per hour", () => {
    const sorted = [
      candidate("a", "2026-10-12T09:00:00-07:00", 0.9),
      candidate("a", "2026-10-12T09:15:00-07:00", 0.89),
      candidate("a", "2026-10-12T09:30:00-07:00", 0.88),
      candidate("a", "2026-10-12T11:00:00-07:00", 0.7),
    ];
    const out = diversify(sorted, 3);
    // 09:00 and 11:00 are distinct hours; 09:15 and 09:30 are the same
    // decision as 09:00 and must not pad the list.
    expect(out.map((c) => c.start.slice(11, 16))).toEqual(["09:00", "11:00"]);
  });

  it("offers a second room in an already-covered hour before repeating one", () => {
    const sorted = [
      candidate("a", "2026-10-12T09:00:00-07:00", 0.9),
      candidate("a", "2026-10-12T09:15:00-07:00", 0.89),
      candidate("b", "2026-10-12T09:00:00-07:00", 0.88),
      candidate("c", "2026-10-12T09:00:00-07:00", 0.87),
    ];
    expect(diversify(sorted, 3).map((c) => c.roomId)).toEqual(["a", "b", "c"]);
  });

  it("spreads across distinct hours before adding more rooms", () => {
    const sorted = [
      candidate("a", "2026-10-12T09:00:00-07:00", 0.9),
      candidate("b", "2026-10-12T09:00:00-07:00", 0.89),
      candidate("a", "2026-10-12T14:00:00-07:00", 0.6),
    ];
    const out = diversify(sorted, 2);
    expect(out.map((c) => c.start.slice(11, 16))).toEqual(["09:00", "14:00"]);
  });

  it("treats the same room on a different day as a distinct option", () => {
    const sorted = [
      candidate("a", "2026-10-12T09:00:00-07:00", 0.9),
      candidate("a", "2026-10-13T09:00:00-07:00", 0.8),
    ];
    expect(diversify(sorted, 2)).toHaveLength(2);
  });

  it("does not pad the list with same-room same-hour duplicates", () => {
    const sorted = [
      candidate("a", "2026-10-12T09:00:00-07:00", 0.9),
      candidate("a", "2026-10-12T09:15:00-07:00", 0.89),
      candidate("a", "2026-10-12T09:30:00-07:00", 0.88),
    ];
    // Three near-identical options are one option; returning a shorter,
    // honest list beats padding it out.
    expect(diversify(sorted, 3)).toHaveLength(1);
  });

  it("never exceeds the limit", () => {
    // 50 candidates but only 5 rooms at one hour, so there are genuinely only
    // 5 distinct options; returning 5 is honest, and the point is that it is
    // never *more* than the limit.
    const narrow = Array.from({ length: 50 }, (_, i) =>
      candidate(`room-${i % 5}`, `2026-10-12T09:00:00-07:00`, 1 - i / 100),
    );
    expect(diversify(narrow, 7).length).toBeLessThanOrEqual(7);

    // With real variety available it fills right up to the limit.
    const varied = Array.from({ length: 50 }, (_, i) =>
      candidate(`room-${i % 5}`, `2026-10-12T${String(7 + (i % 12)).padStart(2, "0")}:00:00-07:00`, 1 - i / 100),
    );
    expect(diversify(varied, 7)).toHaveLength(7);
  });

  it("returns the list in score order, not selection order", () => {
    // The variety passes can append a higher-scoring candidate after a
    // lower-scoring one; a list presented as ranked must still read as ranked.
    const sorted = [
      candidate("a", "2026-10-12T09:00:00-07:00", 0.9),
      candidate("b", "2026-10-12T10:00:00-07:00", 0.5),
      candidate("c", "2026-10-12T10:00:00-07:00", 0.8),
    ];
    const scores = diversify(sorted, 3).map((c) => c.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it("returns everything when under the limit", () => {
    const sorted = [candidate("a", "2026-10-12T09:00:00-07:00", 0.9)];
    expect(diversify(sorted, 10)).toHaveLength(1);
  });
});
