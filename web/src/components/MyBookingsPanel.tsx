/**
 * Bookings this browser created, with cancellation.
 *
 * Scoped to local storage, not the relay — there is no login, so "mine" can
 * only mean "created from this browser, password remembered". The relay
 * itself enforces nothing here beyond requiring the correct password; this
 * panel is what keeps the app from offering to cancel anyone else's booking.
 */

import { useState } from "react";
import { cancelBooking, RelayError } from "../api";
import { listMyBookings, removeMyBooking, type TrackedBooking } from "../lib/myBookings";

interface Props {
  bookings: TrackedBooking[];
  onClose: () => void;
  onChanged: () => void;
}

export function MyBookingsPanel({ bookings, onClose, onChanged }: Props) {
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  async function doCancel(b: TrackedBooking) {
    setCancellingId(b.id);
    setError(null);
    try {
      await cancelBooking(b.roomId, b.id, b.password);
      removeMyBooking(b.roomId, b.id);
      onChanged();
    } catch (err) {
      setError({
        id: b.id,
        message: err instanceof RelayError ? err.message : "Couldn't cancel that.",
      });
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-20 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            My bookings
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            Close
          </button>
        </div>

        {bookings.length === 0 ? (
          <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
            Nothing booked from this browser yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {bookings.map((b) => (
              <li key={`${b.roomId}:${b.id}`} className="py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                      {b.purpose}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {b.roomName} &middot; {formatRange(b.start, b.end)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => doCancel(b)}
                    disabled={cancellingId === b.id}
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                  >
                    {cancellingId === b.id ? "Cancelling…" : "Cancel"}
                  </button>
                </div>
                {error?.id === b.id && (
                  <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">{error.message}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const dateLabel = startIso.slice(0, 10);
  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${dateLabel}, ${fmt(start)}–${fmt(end)}`;
}

export { listMyBookings };
