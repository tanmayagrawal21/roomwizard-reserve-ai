import { describe, expect, it } from "vitest";
import {
  addDays,
  atLocalTime,
  eachLocalDay,
  fromLocalParts,
  parseApplianceTimestamp,
  parseClientDateTime,
  toApplianceDate,
  toApplianceTime,
  toFormDateParts,
  toIso,
  toIsoDate,
} from "../src/time.ts";

describe("appliance timestamps", () => {
  it("parses the JSON response format as Phoenix local", () => {
    const d = parseApplianceTimestamp("2026/10/07 14:00:00");
    // 14:00 Phoenix (UTC-7) is 21:00 UTC.
    expect(d.toISOString()).toBe("2026-10-07T21:00:00.000Z");
  });

  it("tolerates a missing seconds component", () => {
    expect(parseApplianceTimestamp("2026/10/07 14:00").toISOString()).toBe(
      "2026-10-07T21:00:00.000Z",
    );
  });

  it("rejects garbage rather than silently producing an Invalid Date", () => {
    expect(() => parseApplianceTimestamp("not-a-timestamp")).toThrow(/Unrecognized/);
    // `1800` is the exact value BookingForm.action chokes on; we reject it too.
    expect(() => parseApplianceTimestamp("1800")).toThrow(/Unrecognized/);
  });
});

describe("relay -> appliance formats", () => {
  const noon = fromLocalParts(2026, 10, 7, 12, 30, 15);

  it("emits YYYYMMDD and HHMMSS", () => {
    expect(toApplianceDate(noon)).toBe("20261007");
    expect(toApplianceTime(noon)).toBe("123015");
  });

  it("splits dates for the BookingForm selects", () => {
    expect(toFormDateParts(noon)).toEqual({ day: "07", yearMonth: "202610" });
  });

  it("renders a midnight range end as the next day at 000000", () => {
    const midnight = atLocalTime(addDays(noon, 1), 0);
    expect(toApplianceDate(midnight)).toBe("20261008");
    expect(toApplianceTime(midnight)).toBe("000000");
  });
});

describe("relay -> client formats", () => {
  it("emits ISO with the explicit Phoenix offset", () => {
    expect(toIso(fromLocalParts(2026, 10, 7, 14, 0))).toBe("2026-10-07T14:00:00-07:00");
    expect(toIsoDate(fromLocalParts(2026, 10, 7, 14, 0))).toBe("2026-10-07");
  });

  it("round-trips an appliance timestamp without drift", () => {
    expect(toIso(parseApplianceTimestamp("2026/10/07 18:45:00"))).toBe(
      "2026-10-07T18:45:00-07:00",
    );
  });

  it("holds the offset constant across a mainland DST boundary", () => {
    // US DST ended 2026-11-01. Arizona does not observe it, so both sides
    // of that date must still render as -07:00.
    expect(toIso(fromLocalParts(2026, 10, 25, 12, 0))).toContain("-07:00");
    expect(toIso(fromLocalParts(2026, 11, 15, 12, 0))).toContain("-07:00");
  });
});

describe("client -> relay parsing", () => {
  it("treats a bare date as local midnight", () => {
    expect(toIso(parseClientDateTime("2026-10-07"))).toBe("2026-10-07T00:00:00-07:00");
  });

  it("treats a naive datetime as Phoenix local", () => {
    expect(toIso(parseClientDateTime("2026-10-07T14:00"))).toBe("2026-10-07T14:00:00-07:00");
    expect(toIso(parseClientDateTime("2026-10-07 14:00:30"))).toBe("2026-10-07T14:00:30-07:00");
  });

  it("honours an explicit offset or Z", () => {
    // 21:00Z is 14:00 Phoenix.
    expect(toIso(parseClientDateTime("2026-10-07T21:00:00Z"))).toBe("2026-10-07T14:00:00-07:00");
    expect(toIso(parseClientDateTime("2026-10-07T17:00:00-04:00"))).toBe(
      "2026-10-07T14:00:00-07:00",
    );
  });

  it("rejects unparseable input", () => {
    expect(() => parseClientDateTime("next tuesday")).toThrow(/Unrecognized/);
  });
});

describe("day iteration", () => {
  it("is inclusive of both endpoints", () => {
    const days = eachLocalDay(fromLocalParts(2026, 10, 7, 9), fromLocalParts(2026, 10, 9, 17));
    expect(days.map((d) => toIsoDate(d))).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
  });

  it("crosses a month boundary", () => {
    const days = eachLocalDay(fromLocalParts(2026, 10, 31), fromLocalParts(2026, 11, 2));
    expect(days.map((d) => toIsoDate(d))).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("returns a single day for a same-day range", () => {
    const d = fromLocalParts(2026, 10, 7, 9);
    expect(eachLocalDay(d, d).map((x) => toIsoDate(x))).toEqual(["2026-10-07"]);
  });
});
