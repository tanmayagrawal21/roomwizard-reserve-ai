/**
 * Server-side record of bookings made through this app.
 *
 * ## Why this exists, and what it costs
 *
 * Until now the relay was deliberately stateless about passwords: it generated
 * one, returned it once, and forgot it, with the browser's local storage as the
 * only record (PLAN.md section 7). That is the safer posture, but it makes the
 * assistant structurally incapable of listing, rescheduling or cancelling
 * anything — those need the password, and the relay had no way to know it.
 *
 * Giving the assistant end-to-end capability therefore means persisting
 * passwords here. The honest trade:
 *
 *   - This database is now sensitive. It holds the only credential protecting
 *     each booking it created. Keep it on the campus host, in the named Docker
 *     volume, and out of casual backups.
 *   - It does NOT widen what the *appliance* exposes. Those passwords already
 *     travel to the browser, and the appliance already discloses its own
 *     derived form of them to any unauthenticated caller. See PLAN.md
 *     section 7.
 *   - Ownership is a bearer key, not an account. Anyone holding the key can
 *     act on its bookings. That is the same trust level as holding the
 *     passwords themselves, which is what the browser already had.
 */

import { createRequire } from "node:module";
import { CHAT_DB_PATH } from "./config.ts";

/**
 * `node:sqlite` is resolved through `createRequire` rather than a static
 * import. It is a real builtin, but Node does not list it in
 * `module.builtinModules`, so Vite (and therefore Vitest) treats the static
 * import as a missing package and fails with "Failed to load url sqlite".
 * Going through `createRequire` keeps it out of the bundler's module graph
 * while behaving identically at runtime.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDb;
};

/** The slice of node:sqlite's API this module uses. */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}


export interface OwnedBooking {
  bookingId: string;
  roomId: string;
  roomName: string;
  start: string;
  end: string;
  purpose: string;
  password: string;
  createdAt: string;
}

let db: SqliteDb | null = null;
let dbPath: string = CHAT_DB_PATH;

function open(): SqliteDb {
  if (db) return db;
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS owned_bookings (
      owner_key   TEXT NOT NULL,
      booking_id  TEXT NOT NULL,
      room_id     TEXT NOT NULL,
      room_name   TEXT NOT NULL,
      start_iso   TEXT NOT NULL,
      end_iso     TEXT NOT NULL,
      purpose     TEXT NOT NULL,
      password    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_key, room_id, booking_id)
    );
    CREATE INDEX IF NOT EXISTS idx_owned_owner ON owned_bookings (owner_key, end_iso);
  `);
  return db;
}

/** What a caller supplies; `createdAt` comes from the column default. */
export type NewOwnedBooking = Omit<OwnedBooking, "createdAt">;

export function recordBooking(ownerKey: string, b: NewOwnedBooking): void {
  open()
    .prepare(
      `INSERT OR REPLACE INTO owned_bookings
         (owner_key, booking_id, room_id, room_name, start_iso, end_iso, purpose, password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ownerKey,
      b.bookingId,
      b.roomId,
      b.roomName,
      b.start,
      b.end,
      b.purpose,
      b.password,
    );
}

/** Still-upcoming bookings for this owner, soonest first. */
export function listOwnedBookings(ownerKey: string, nowIso: string): OwnedBooking[] {
  const rows = open()
    .prepare(
      `SELECT * FROM owned_bookings
        WHERE owner_key = ? AND end_iso > ?
        ORDER BY start_iso ASC`,
    )
    .all(ownerKey, nowIso) as unknown as Record<string, unknown>[];
  return rows.map(toOwned);
}

export function findOwnedBooking(
  ownerKey: string,
  roomId: string,
  bookingId: string,
): OwnedBooking | null {
  const row = open()
    .prepare(
      `SELECT * FROM owned_bookings WHERE owner_key = ? AND room_id = ? AND booking_id = ?`,
    )
    .get(ownerKey, roomId, bookingId) as unknown as Record<string, unknown> | undefined;
  return row ? toOwned(row) : null;
}

export function forgetBooking(ownerKey: string, roomId: string, bookingId: string): void {
  open()
    .prepare(`DELETE FROM owned_bookings WHERE owner_key = ? AND room_id = ? AND booking_id = ?`)
    .run(ownerKey, roomId, bookingId);
}

/** Update the stored times/purpose after a successful reschedule. */
export function updateOwnedBooking(
  ownerKey: string,
  roomId: string,
  bookingId: string,
  patch: { start: string; end: string; purpose: string },
): void {
  open()
    .prepare(
      `UPDATE owned_bookings SET start_iso = ?, end_iso = ?, purpose = ?
        WHERE owner_key = ? AND room_id = ? AND booking_id = ?`,
    )
    .run(patch.start, patch.end, patch.purpose, ownerKey, roomId, bookingId);
}

/** Drop anything that has already finished, so the table does not grow forever. */
export function pruneOwnedBookings(nowIso: string): number {
  const res = open().prepare(`DELETE FROM owned_bookings WHERE end_iso <= ?`).run(nowIso);
  return Number(res.changes ?? 0);
}

function toOwned(r: Record<string, unknown>): OwnedBooking {
  return {
    bookingId: r.booking_id as string,
    roomId: r.room_id as string,
    roomName: r.room_name as string,
    start: r.start_iso as string,
    end: r.end_iso as string,
    purpose: r.purpose as string,
    password: r.password as string,
    createdAt: r.created_at as string,
  };
}

/** Test seam, mirroring `chatStore.configureStore`. */
export function configureBookingStore(path = ":memory:"): void {
  db?.close();
  db = null;
  dbPath = path;
}
