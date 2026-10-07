/**
 * Timezone portability.
 *
 * The building this was developed against is in America/Phoenix, which never
 * observes DST — so a fixed -07:00 offset happened to work. These tests exist
 * to stop that assumption creeping back in, by exercising zones that do shift,
 * use a half-hour offset, or sit east of UTC.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  atLocalTime,
  eachLocalDay,
  fromLocalParts,
  localParts,
  offsetLabel,
  offsetMinutesAt,
  parseApplianceTimestamp,
  toApplianceDate,
  toApplianceTime,
  toIso,
  toIsoDate,
} from "../src/time.ts";

const NY = "America/New_York";
const KOLKATA = "Asia/Kolkata";
const BERLIN = "Europe/Berlin";
const UTC = "UTC";
const PHX = "America/Phoenix";

describe("offset handling across zones", () => {
  it("reports the correct offset either side of a US DST transition", () => {
    // DST ended 2026-11-01 in the US: EDT (-4) before, EST (-5) after.
    expect(offsetMinutesAt(fromLocalParts(2026, 10, 15, 12, 0, 0, NY), NY)).toBe(-240);
    expect(offsetMinutesAt(fromLocalParts(2026, 11, 15, 12, 0, 0, NY), NY)).toBe(-300);
  });

  it("renders the shifting offset in ISO output", () => {
    expect(toIso(fromLocalParts(2026, 10, 15, 12, 0, 0, NY), NY)).toBe(
      "2026-10-15T12:00:00-04:00",
    );
    expect(toIso(fromLocalParts(2026, 11, 15, 12, 0, 0, NY), NY)).toBe(
      "2026-11-15T12:00:00-05:00",
    );
  });

  it("holds Phoenix constant across the same transition", () => {
    expect(offsetMinutesAt(fromLocalParts(2026, 10, 15, 12, 0, 0, PHX), PHX)).toBe(-420);
    expect(offsetMinutesAt(fromLocalParts(2026, 11, 15, 12, 0, 0, PHX), PHX)).toBe(-420);
  });

  it("handles a half-hour offset east of UTC", () => {
    expect(offsetLabel(fromLocalParts(2026, 10, 15, 12, 0, 0, KOLKATA), KOLKATA)).toBe("+05:30");
    expect(toIso(fromLocalParts(2026, 10, 15, 9, 30, 0, KOLKATA), KOLKATA)).toBe(
      "2026-10-15T09:30:00+05:30",
    );
  });

  it("renders UTC as Z", () => {
    expect(offsetLabel(fromLocalParts(2026, 10, 15, 12, 0, 0, UTC), UTC)).toBe("Z");
    expect(toIso(fromLocalParts(2026, 10, 15, 12, 0, 0, UTC), UTC)).toBe(
      "2026-10-15T12:00:00Z",
    );
  });
});

describe("round-tripping wall-clock values", () => {
  for (const tz of [PHX, NY, KOLKATA, BERLIN, UTC]) {
    it(`preserves local wall-clock time in ${tz}`, () => {
      for (const [mo, d, h] of [
        [1, 15, 9],
        [6, 15, 14],
        [10, 15, 18],
        [12, 31, 23],
      ] as const) {
        const inst = fromLocalParts(2026, mo, d, h, 30, 0, tz);
        const p = localParts(inst, tz);
        expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, mo, d, h, 30]);
      }
    });
  }

  it("round-trips an appliance timestamp in a DST zone", () => {
    // The appliance emits naive wall-clock; we must read it back unchanged.
    const inst = parseApplianceTimestamp("2026/07/04 14:00:00", NY);
    expect(toApplianceDate(inst, NY)).toBe("20260704");
    expect(toApplianceTime(inst, NY)).toBe("140000");
    expect(toIso(inst, NY)).toBe("2026-07-04T14:00:00-04:00");
  });
});

describe("DST transition edge cases", () => {
  it("adds a calendar day across a spring-forward boundary", () => {
    // 2026-03-08 is the US spring-forward date. 09:00 the next day must still
    // read as 09:00 local, even though only 23 hours elapsed.
    const before = fromLocalParts(2026, 3, 7, 9, 0, 0, NY);
    const after = addDays(before, 1, NY);
    expect(toIso(after, NY)).toBe("2026-03-08T09:00:00-04:00");
    // Elapsed real time is 23h, which is the point of using calendar math.
    expect(after.getTime() - before.getTime()).toBe(23 * 3_600_000);
  });

  it("adds a calendar day across a fall-back boundary", () => {
    const before = fromLocalParts(2026, 10, 31, 9, 0, 0, NY);
    const after = addDays(before, 1, NY);
    expect(toIso(after, NY)).toBe("2026-11-01T09:00:00-05:00");
    expect(after.getTime() - before.getTime()).toBe(25 * 3_600_000);
  });

  it("enumerates every day across a transition without skipping or repeating", () => {
    const days = eachLocalDay(
      fromLocalParts(2026, 10, 30, 0, 0, 0, NY),
      fromLocalParts(2026, 11, 2, 0, 0, 0, NY),
      NY,
    );
    expect(days.map((d) => toIsoDate(d, NY))).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("resolves a nonexistent wall-clock time to a real instant", () => {
    // 02:30 on spring-forward night does not exist in New York. We must still
    // return something sane rather than NaN or a time in the wrong day.
    const inst = fromLocalParts(2026, 3, 8, 2, 30, 0, NY);
    expect(Number.isNaN(inst.getTime())).toBe(false);
    expect(toIsoDate(inst, NY)).toBe("2026-03-08");
  });
});

describe("atLocalTime", () => {
  it("treats hour 24 as midnight ending the day", () => {
    // The appliances express a timeline running to end-of-day as "00"/24.
    const day = fromLocalParts(2026, 10, 15, 0, 0, 0, NY);
    expect(toIso(atLocalTime(day, 24, 0, NY), NY)).toBe("2026-10-16T00:00:00-04:00");
  });

  it("keeps the wall-clock hour across a fall-back day", () => {
    const day = fromLocalParts(2026, 11, 1, 0, 0, 0, NY);
    expect(toIso(atLocalTime(day, 19, 0, NY), NY)).toBe("2026-11-01T19:00:00-05:00");
  });
});

describe("misconfiguration", () => {
  it("rejects an unknown timezone with an actionable message", () => {
    expect(() => toIso(new Date(), "Mars/Olympus_Mons")).toThrow(/RW_TIMEZONE/);
  });

  it("explains the Array.map footgun rather than reporting a bad zone", () => {
    // .map(toIso) passes the index into the timeZone slot.
    expect(() => [new Date()].map(toIso as never)).toThrow(/Array\.map passes/);
  });
});
