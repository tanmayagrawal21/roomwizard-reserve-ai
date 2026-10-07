import { describe, expect, it } from "vitest";
import {
  generateBookingPassword,
  isAcceptedRedirect,
  matchCreatedBooking,
} from "../src/booking.ts";
import type { RawBooking } from "../src/roomwizard.ts";
import { fromLocalParts } from "../src/time.ts";

function booking(overrides: Partial<RawBooking>): RawBooking {
  return {
    Id: "1",
    start: "2026/10/08 14:00:00",
    end: "2026/10/08 15:00:00",
    purpose: "Lab meeting",
    notes: "",
    hostFirstName: "Sam",
    hostLastName: "Rivera",
    hostEmail: "",
    isConfidential: false,
    hideMeetingDetails: false,
    isPasswordProtected: true,
    creationDate: "2026/10/07 09:00:00",
    modificationDate: "2026/10/07 09:00:00",
    ...overrides,
  };
}

describe("isAcceptedRedirect", () => {
  it("accepts a 302 to GroupView.action", () => {
    expect(isAcceptedRedirect({ status: 302, location: "GroupView.action?display_date=20261008" })).toBe(
      true,
    );
  });

  it("accepts a relative or absolute Location, any 3xx", () => {
    expect(isAcceptedRedirect({ status: 303, location: "/GroupView.action" })).toBe(true);
    expect(
      isAcceptedRedirect({ status: 301, location: "https://bsrl-203.arizona.edu/GroupView.action" }),
    ).toBe(true);
  });

  it("rejects a 200 (the form was re-rendered, not accepted)", () => {
    expect(isAcceptedRedirect({ status: 200, location: null })).toBe(false);
  });

  it("rejects a redirect that goes somewhere other than GroupView", () => {
    expect(isAcceptedRedirect({ status: 302, location: "BookingForm.action" })).toBe(false);
  });

  it("rejects a redirect with no Location header", () => {
    expect(isAcceptedRedirect({ status: 302, location: null })).toBe(false);
  });
});

describe("matchCreatedBooking", () => {
  const start = fromLocalParts(2026, 10, 8, 14, 0);
  const end = fromLocalParts(2026, 10, 8, 15, 0);

  it("finds the single booking matching our exact start/end", () => {
    const raw = [booking({ Id: "9001" })];
    expect(matchCreatedBooking(raw, start, end, "Lab meeting")?.id).toBe("9001");
  });

  it("ignores bookings at other times in the same room", () => {
    const raw = [
      booking({ Id: "1", start: "2026/10/08 09:00:00", end: "2026/10/08 10:00:00" }),
      booking({ Id: "2" }),
    ];
    expect(matchCreatedBooking(raw, start, end, "Lab meeting")?.id).toBe("2");
  });

  it("returns null when nothing matches the requested slot", () => {
    const raw = [booking({ start: "2026/10/08 09:00:00", end: "2026/10/08 10:00:00" })];
    expect(matchCreatedBooking(raw, start, end, "Lab meeting")).toBeNull();
  });

  it("prefers an exact purpose match when two bookings race to the same slot", () => {
    const raw = [
      booking({ Id: "old", purpose: "Someone else's meeting", creationDate: "2026/10/07 09:00:00" }),
      booking({ Id: "mine", purpose: "Lab meeting", creationDate: "2026/10/07 09:00:01" }),
    ];
    expect(matchCreatedBooking(raw, start, end, "Lab meeting")?.id).toBe("mine");
  });

  it("falls back to the most recently created when purpose matches neither", () => {
    const raw = [
      booking({ Id: "older", purpose: "Other", creationDate: "2026/10/07 09:00:00" }),
      booking({ Id: "newer", purpose: "Other too", creationDate: "2026/10/07 09:05:00" }),
    ];
    expect(matchCreatedBooking(raw, start, end, "Lab meeting")?.id).toBe("newer");
  });
});

describe("generateBookingPassword", () => {
  it("produces a long, URL-safe, non-empty password", () => {
    const pw = generateBookingPassword();
    expect(pw.length).toBeGreaterThanOrEqual(20);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not repeat across calls", () => {
    const a = generateBookingPassword();
    const b = generateBookingPassword();
    expect(a).not.toBe(b);
  });
});
