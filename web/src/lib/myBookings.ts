/**
 * Bookings this browser has created, tracked locally.
 *
 * The relay is deliberately stateless and never stores a booking's password
 * (PLAN.md section 7) — it hands the password back exactly once, at creation.
 * This is the only place that password is kept, so it has to be captured here
 * immediately or cancelling later becomes impossible. Scoping cancellation to
 * "bookings this app created" rather than exposing a blanket cancel-anything
 * tool is also the point: the appliance has no auth, so this is the one
 * boundary the app itself enforces.
 */

const KEY = "myBookings";

export interface TrackedBooking {
  id: string;
  roomId: string;
  roomName: string;
  start: string;
  end: string;
  purpose: string;
  password: string;
  createdAt: string;
}

function readAll(): TrackedBooking[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TrackedBooking[]) : [];
  } catch {
    return [];
  }
}

function writeAll(bookings: TrackedBooking[]): void {
  localStorage.setItem(KEY, JSON.stringify(bookings));
}

/** Newest first — that's almost always the one someone just made. */
export function listMyBookings(): TrackedBooking[] {
  return readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addMyBooking(b: TrackedBooking): void {
  writeAll([...readAll(), b]);
}

export function removeMyBooking(roomId: string, id: string): void {
  writeAll(readAll().filter((b) => !(b.roomId === roomId && b.id === id)));
}

/**
 * Drop anything whose end time has already passed, so the list doesn't grow
 * forever.
 *
 * Compares real instants via `Date`, not the ISO strings directly: the relay
 * always returns a `-07:00`-suffixed timestamp, but `Date.toISOString()`
 * always returns `Z`. Those sort correctly against each other numerically,
 * but NOT lexicographically — "19:00:00-07:00" (02:00 UTC the next day) reads
 * as earlier than "23:53:00.000Z" by plain string comparison, because '1' is
 * a smaller character than '2'. A plain `b.end > nowIso` string compare
 * deleted bookings that hadn't even happened yet — caught by driving the
 * actual booking UI end-to-end rather than only unit-testing in isolation.
 */
export function pruneExpired(nowIso: string): void {
  const now = new Date(nowIso).getTime();
  const all = readAll();
  const kept = all.filter((b) => new Date(b.end).getTime() > now);
  if (kept.length !== all.length) writeAll(kept);
}
