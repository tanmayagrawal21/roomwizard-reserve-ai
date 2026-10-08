import { beforeEach, describe, expect, it } from "vitest";
import { addMyBooking, listMyBookings, pruneExpired, removeMyBooking } from "./myBookings";

beforeEach(() => localStorage.clear());

function booking(overrides: Partial<Parameters<typeof addMyBooking>[0]> = {}) {
  return {
    id: "1",
    roomId: "bsrl-340",
    roomName: "BSRL-340",
    start: "2026-10-07T18:00:00-07:00",
    end: "2026-10-07T19:00:00-07:00",
    purpose: "Test",
    password: "pw",
    createdAt: "2026-10-07T20:00:00.000Z",
    ...overrides,
  };
}

describe("add / list / remove", () => {
  it("round-trips through localStorage", () => {
    addMyBooking(booking());
    expect(listMyBookings()).toHaveLength(1);
    removeMyBooking("bsrl-340", "1");
    expect(listMyBookings()).toHaveLength(0);
  });

  it("lists newest first", () => {
    addMyBooking(booking({ id: "1", createdAt: "2026-10-07T20:00:00.000Z" }));
    addMyBooking(booking({ id: "2", createdAt: "2026-10-07T21:00:00.000Z" }));
    expect(listMyBookings().map((b) => b.id)).toEqual(["2", "1"]);
  });

  it("removes only the matching room+id pair", () => {
    addMyBooking(booking({ id: "1", roomId: "bsrl-340" }));
    addMyBooking(booking({ id: "1", roomId: "bsrl-203" }));
    removeMyBooking("bsrl-340", "1");
    expect(listMyBookings()).toEqual([booking({ id: "1", roomId: "bsrl-203" })]);
  });

  it("returns an empty list rather than throwing on corrupt storage", () => {
    localStorage.setItem("myBookings", "not json");
    expect(listMyBookings()).toEqual([]);
  });
});

describe("pruneExpired", () => {
  it("keeps a booking that ends in the future", () => {
    addMyBooking(booking({ end: "2026-10-08T10:00:00-07:00" }));
    pruneExpired("2026-10-07T20:00:00.000Z");
    expect(listMyBookings()).toHaveLength(1);
  });

  it("drops a booking that has actually ended", () => {
    addMyBooking(booking({ end: "2026-10-06T10:00:00-07:00" }));
    pruneExpired("2026-10-07T20:00:00.000Z");
    expect(listMyBookings()).toHaveLength(0);
  });

  it("does not drop a booking whose end time merely *looks* earlier as a string", () => {
    // 19:00-07:00 is 02:00 UTC the *next* day — genuinely in the future
    // relative to 23:53 UTC the same day — but a lexicographic string
    // comparison sees "19" < "23" and would call it expired. This is the
    // exact bug a live create-then-view-My-Bookings pass caught: a booking
    // just created for later that evening vanished from the list immediately.
    addMyBooking(booking({ end: "2026-10-07T19:00:00-07:00" }));
    pruneExpired("2026-10-07T23:53:00.000Z");
    expect(listMyBookings()).toHaveLength(1);
  });

  it("drops only the expired entries, keeping the rest", () => {
    addMyBooking(booking({ id: "old", end: "2026-10-01T10:00:00-07:00" }));
    addMyBooking(booking({ id: "new", end: "2026-10-08T10:00:00-07:00" }));
    pruneExpired("2026-10-07T20:00:00.000Z");
    expect(listMyBookings().map((b) => b.id)).toEqual(["new"]);
  });
});
