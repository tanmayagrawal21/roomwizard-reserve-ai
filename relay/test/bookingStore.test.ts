import { beforeEach, describe, expect, it } from "vitest";
import {
  configureBookingStore,
  findOwnedBooking,
  forgetBooking,
  listOwnedBookings,
  pruneOwnedBookings,
  recordBooking,
  updateOwnedBooking,
} from "../src/bookingStore.ts";

beforeEach(() => configureBookingStore(":memory:"));

const NOW = "2026-10-13T12:00:00-07:00";

function booking(over: Partial<Parameters<typeof recordBooking>[1]> = {}) {
  return {
    bookingId: "100",
    roomId: "bsrl-203",
    roomName: "BSRL-203",
    start: "2026-10-14T14:00:00-07:00",
    end: "2026-10-14T15:00:00-07:00",
    purpose: "Lab meeting",
    password: "pw-100",
    ...over,
  };
}

describe("record and list", () => {
  it("round-trips a booking for its owner", () => {
    recordBooking("owner-a", booking());
    const mine = listOwnedBookings("owner-a", NOW);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.purpose).toBe("Lab meeting");
    expect(mine[0]!.password).toBe("pw-100");
  });

  it("keeps owners separate", () => {
    recordBooking("owner-a", booking({ bookingId: "100" }));
    recordBooking("owner-b", booking({ bookingId: "200" }));
    expect(listOwnedBookings("owner-a", NOW).map((b) => b.bookingId)).toEqual(["100"]);
    expect(listOwnedBookings("owner-b", NOW).map((b) => b.bookingId)).toEqual(["200"]);
  });

  it("returns nothing for an unknown owner", () => {
    recordBooking("owner-a", booking());
    expect(listOwnedBookings("nobody", NOW)).toEqual([]);
  });

  it("lists soonest first", () => {
    recordBooking("o", booking({ bookingId: "late", start: "2026-10-16T09:00:00-07:00", end: "2026-10-16T10:00:00-07:00" }));
    recordBooking("o", booking({ bookingId: "soon", start: "2026-10-14T09:00:00-07:00", end: "2026-10-14T10:00:00-07:00" }));
    expect(listOwnedBookings("o", NOW).map((b) => b.bookingId)).toEqual(["soon", "late"]);
  });

  it("hides bookings that have already finished", () => {
    recordBooking("o", booking({ bookingId: "past", start: "2026-10-01T09:00:00-07:00", end: "2026-10-01T10:00:00-07:00" }));
    recordBooking("o", booking({ bookingId: "future" }));
    expect(listOwnedBookings("o", NOW).map((b) => b.bookingId)).toEqual(["future"]);
  });

  it("re-recording the same booking replaces rather than duplicates", () => {
    recordBooking("o", booking({ purpose: "First" }));
    recordBooking("o", booking({ purpose: "Second" }));
    const mine = listOwnedBookings("o", NOW);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.purpose).toBe("Second");
  });

  it("treats the same booking id in different rooms as distinct", () => {
    // Appliance ids are per-room, so they genuinely collide across rooms.
    recordBooking("o", booking({ bookingId: "7", roomId: "bsrl-203" }));
    recordBooking("o", booking({ bookingId: "7", roomId: "bsrl-258" }));
    expect(listOwnedBookings("o", NOW)).toHaveLength(2);
  });
});

describe("find", () => {
  it("finds by owner, room and id", () => {
    recordBooking("o", booking());
    expect(findOwnedBooking("o", "bsrl-203", "100")?.password).toBe("pw-100");
  });

  it("will not find another owner's booking", () => {
    recordBooking("owner-a", booking());
    expect(findOwnedBooking("owner-b", "bsrl-203", "100")).toBeNull();
  });

  it("will not find the right id in the wrong room", () => {
    recordBooking("o", booking({ roomId: "bsrl-203" }));
    expect(findOwnedBooking("o", "bsrl-258", "100")).toBeNull();
  });
});

describe("forget and update", () => {
  it("forgets only the named booking", () => {
    recordBooking("o", booking({ bookingId: "1" }));
    recordBooking("o", booking({ bookingId: "2" }));
    forgetBooking("o", "bsrl-203", "1");
    expect(listOwnedBookings("o", NOW).map((b) => b.bookingId)).toEqual(["2"]);
  });

  it("will not let one owner forget another's booking", () => {
    recordBooking("owner-a", booking());
    forgetBooking("owner-b", "bsrl-203", "100");
    expect(listOwnedBookings("owner-a", NOW)).toHaveLength(1);
  });

  it("updates times and purpose after a reschedule", () => {
    recordBooking("o", booking());
    updateOwnedBooking("o", "bsrl-203", "100", {
      start: "2026-10-15T16:00:00-07:00",
      end: "2026-10-15T17:00:00-07:00",
      purpose: "Moved",
    });
    const b = findOwnedBooking("o", "bsrl-203", "100")!;
    expect(b.purpose).toBe("Moved");
    expect(b.start).toBe("2026-10-15T16:00:00-07:00");
    // The password must survive a reschedule, or the booking becomes
    // uncancellable through the assistant.
    expect(b.password).toBe("pw-100");
  });
});

describe("pruneOwnedBookings", () => {
  it("drops finished bookings and reports how many", () => {
    recordBooking("o", booking({ bookingId: "old", start: "2026-10-01T09:00:00-07:00", end: "2026-10-01T10:00:00-07:00" }));
    recordBooking("o", booking({ bookingId: "new" }));
    expect(pruneOwnedBookings(NOW)).toBe(1);
    expect(listOwnedBookings("o", NOW).map((b) => b.bookingId)).toEqual(["new"]);
  });

  it("is a no-op when nothing has finished", () => {
    recordBooking("o", booking());
    expect(pruneOwnedBookings(NOW)).toBe(0);
  });
});
