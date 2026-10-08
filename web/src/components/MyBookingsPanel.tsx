/**
 * Bookings this browser created, with cancellation.
 *
 * "Mine" is scoped to local storage, not the relay — there is no login, so it
 * can only mean "created from this browser, password remembered". Editing or
 * cancelling a booking this browser *doesn't* recognize happens from the
 * booking's own preview pane instead (click it on a timeline) — that is
 * where the appliance's password check actually lives, so a booking id
 * typed into a form here would just be duplicating that flow in a second
 * place.
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
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

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

  function toggleRevealed(key: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
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
            Nothing booked from this browser yet. Booking something from here, or unlocking
            someone else's booking on its own preview pane and choosing to remember it, is what
            adds one.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {bookings.map((b) => {
              const key = `${b.roomId}:${b.id}`;
              const isRevealed = revealed.has(key);
              return (
                <li key={key} className="py-2.5">
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

                  <button
                    type="button"
                    onClick={() => toggleRevealed(key)}
                    className="mt-1 text-[11px] font-medium text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                  >
                    {isRevealed ? "Hide password" : "Show password"}
                  </button>
                  {isRevealed && (
                    <div className="mt-1 flex items-center gap-2">
                      <code className="flex-1 truncate rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700">
                        {b.password}
                      </code>
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(b.password)}
                        className="rounded px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                      >
                        Copy
                      </button>
                    </div>
                  )}

                  {error?.id === b.id && (
                    <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                      {error.message}
                    </p>
                  )}
                </li>
              );
            })}
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
