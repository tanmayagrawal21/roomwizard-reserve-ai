import { describe, expect, it } from "vitest";
import roster from "./fixtures/roster.json" with { type: "json" };
import {
  inferAmenities,
  inferFloor,
  normalizeRoster,
  roomIdFromHost,
  type Room,
} from "../src/rooms.ts";
import type { RawRoster } from "../src/roomwizard.ts";

const fleet = normalizeRoster(roster as unknown as RawRoster);
const byId = (id: string): Room => {
  const r = fleet.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`no room ${id} in fixture`);
  return r;
};

describe("roomIdFromHost", () => {
  it("takes the first hostname label", () => {
    expect(roomIdFromHost("https://bsrl-203.arizona.edu/")).toBe("bsrl-203");
  });

  it("survives a host without a scheme", () => {
    expect(roomIdFromHost("bsrl-100.arizona.edu")).toBe("bsrl-100");
  });
});

describe("inferFloor", () => {
  it("prefers the room number, which is the building's own convention", () => {
    expect(inferFloor("BSRL-203", "")).toBe(2);
    expect(inferFloor("BSRL-450", "")).toBe(4);
    expect(inferFloor("BSRL-100", "")).toBe(1);
  });

  it("falls back to ordinals in the location text", () => {
    expect(inferFloor("Annex", "3rd Floor North")).toBe(3);
    expect(inferFloor("Annex", "1st floor South near elevator")).toBe(1);
    expect(inferFloor("Annex", "Second floor North Large room")).toBe(2);
  });

  it("returns null when there is nothing to go on", () => {
    expect(inferFloor("Conference Room", "")).toBeNull();
  });

  it("does not invent a floor from a number out of range", () => {
    // Room number parses to floor 0, which is not a real floor here.
    expect(inferFloor("BSRL-012", "")).toBeNull();
  });
});

describe("inferAmenities", () => {
  it("detects a camera from either phrasing", () => {
    expect(inferAmenities("Integrated Pan Tilt Zoom Camera")).toContain("camera");
    expect(inferAmenities("Integrated PTZ Camera")).toContain("camera");
  });

  it("detects an in-room PC", () => {
    expect(inferAmenities("In-room Windows 10 PC")).toContain("pc");
  });

  it("detects Cisco video and audio conferencing separately", () => {
    const tags = inferAmenities("Cisco-IP Based Video conferencing\nAudio Conferencing.");
    expect(tags).toContain("cisco_vc");
    expect(tags).toContain("audio_conf");
  });

  it("returns nothing for an empty blurb", () => {
    expect(inferAmenities("")).toEqual([]);
  });
});

describe("normalizeRoster", () => {
  it("reads the bookable window off the appliance", () => {
    expect(fleet.dayStartHour).toBe(7);
    expect(fleet.dayEndHour).toBe(19);
    expect(fleet.slotMinutes).toBe(15);
    expect(fleet.timezone).toBe("America/Phoenix");
  });

  it("normalizes the appliance clock to ISO", () => {
    expect(fleet.applianceTime).toBe("2026-10-08T09:15:00-07:00");
  });

  it("sorts rooms by name numerically, not lexically", () => {
    expect(fleet.rooms.map((r) => r.name)).toEqual([
      "BSRL-100",
      "BSRL-258",
      "BSRL-340",
      "BSRL-450",
    ]);
  });

  it("carries capacity and derived tags through", () => {
    const r = byId("bsrl-258");
    expect(r.capacity).toBe(10);
    expect(r.floor).toBe(2);
    expect(r.amenities).toEqual(expect.arrayContaining(["camera", "cisco_vc", "pc"]));
  });

  it("marks a room the roster reported as unreachable", () => {
    expect(byId("bsrl-450").online).toBe(false);
    expect(byId("bsrl-258").online).toBe(true);
  });

  it("handles a room with no facilities listed", () => {
    expect(byId("bsrl-340").amenities).toEqual([]);
    expect(byId("bsrl-340").floor).toBe(3);
  });
});

describe("timeline bounds", () => {
  it("treats a midnight end of 00 as hour 24", () => {
    const f = normalizeRoster({
      ...(roster as unknown as RawRoster),
      timelineStart: "07",
      timelineEnd: "00",
    });
    expect(f.dayEndHour).toBe(24);
  });

  it("falls back to defaults when the bounds are nonsense", () => {
    const f = normalizeRoster({
      ...(roster as unknown as RawRoster),
      timelineStart: "banana",
      timelineEnd: "99",
    });
    expect(f.dayStartHour).toBe(7);
    expect(f.dayEndHour).toBe(19);
  });
});
