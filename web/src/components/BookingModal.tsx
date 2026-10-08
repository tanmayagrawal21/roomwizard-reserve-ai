/**
 * Create-booking form, opened by clicking a free slot on a room's timeline.
 *
 * Deliberately narrow, matching what the relay actually accepts (PLAN.md
 * section 2): purpose, a name, start, end. No recurrence, invitees, or cost
 * centers — those exist on the real appliance form but Phase 3 doesn't
 * support them.
 *
 * Times are sent as naive local strings ("2026-10-08T14:00:00", no offset)
 * rather than computed in the browser's own timezone. The relay's
 * `parseClientDateTime` already resolves a naive datetime as the *fleet's*
 * configured zone — reusing that is simpler and more correct than duplicating
 * timezone math on the client to produce a real offset.
 */

import { useState } from "react";
import { createBooking, RelayError, type Room } from "../api";
import { addMyBooking } from "../lib/myBookings";
import { getProfile, saveProfile } from "../lib/profile";

interface Props {
  room: Room;
  date: string;
  /** Minutes from local midnight, already snapped to the slot grid. */
  startMinute: number;
  dayEndHour: number;
  slotMinutes: number;
  onClose: () => void;
  onBooked: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

function minuteToClock(minute: number): string {
  return `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;
}

function minuteTo12h(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const suffix = h < 12 ? "am" : "pm";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${pad(m)} ${suffix}`;
}

const DURATIONS = [15, 30, 45, 60, 90, 120];

export function BookingModal({
  room,
  date,
  startMinute,
  dayEndHour,
  slotMinutes,
  onClose,
  onBooked,
}: Props) {
  const profile = getProfile();
  const [purpose, setPurpose] = useState("");
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [duration, setDuration] = useState(
    Math.min(60, dayEndHour * 60 - startMinute) || slotMinutes,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ password: string } | null>(null);

  const maxDuration = Math.max(slotMinutes, dayEndHour * 60 - startMinute);
  const endMinute = startMinute + duration;

  const canSubmit = purpose.trim() !== "" && (firstName.trim() !== "" || lastName.trim() !== "");

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const start = `${date}T${minuteToClock(startMinute)}:00`;
      const end = `${date}T${minuteToClock(endMinute)}:00`;
      const result = await createBooking({
        roomId: room.id,
        start,
        end,
        purpose: purpose.trim(),
        hostFirstName: firstName.trim(),
        hostLastName: lastName.trim(),
      });
      saveProfile({ firstName: firstName.trim(), lastName: lastName.trim() });
      addMyBooking({
        id: result.id,
        roomId: result.roomId,
        roomName: room.name,
        start: result.start,
        end: result.end,
        purpose: result.purpose,
        password: result.password,
        createdAt: new Date().toISOString(),
      });
      setCreated({ password: result.password });
      onBooked();
    } catch (err) {
      setError(err instanceof RelayError ? err.message : "Something went wrong booking that.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-20 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        {created ? (
          <Confirmation
            roomName={room.name}
            start={minuteTo12h(startMinute)}
            end={minuteTo12h(endMinute)}
            password={created.password}
            onClose={onClose}
          />
        ) : (
          <>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Book {room.name}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {minuteTo12h(startMinute)} &ndash; {minuteTo12h(endMinute)}
            </p>

            <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Duration
            </label>
            <div className="mt-1 flex flex-wrap gap-1">
              {DURATIONS.filter((d) => d <= maxDuration).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d)}
                  aria-pressed={duration === d}
                  className={
                    "rounded-full px-2 py-0.5 text-xs font-medium transition-colors " +
                    (duration === d
                      ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700")
                  }
                >
                  {d < 60 ? `${d}m` : d % 60 === 0 ? `${d / 60}h` : `${Math.floor(d / 60)}h${d % 60}m`}
                </button>
              ))}
            </div>

            <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">
              What's this for?
            </label>
            <input
              type="text"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              maxLength={50}
              autoFocus
              placeholder="Lab meeting"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />

            <div className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                  First name
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  maxLength={50}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Last name
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  maxLength={50}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
            </div>

            {error && (
              <p className="mt-3 rounded-md bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
                {error}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit || submitting}
                className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
              >
                {submitting ? "Booking…" : "Book it"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Confirmation({
  roomName,
  start,
  end,
  password,
  onClose,
}: {
  roomName: string;
  start: string;
  end: string;
  password: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Booked</h2>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
        {roomName}, {start} &ndash; {end}.
      </p>
      <div className="mt-3 rounded-md bg-amber-50 p-3 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-900/60">
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
          Cancellation password — shown once
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-300/90">
          Saved to this browser's My Bookings list already, so you don't need to copy it — but
          if you clear site data you'll lose the ability to cancel from here. The room system
          itself never shows this again.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-white px-2 py-1 text-[11px] text-slate-700 ring-1 ring-amber-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-amber-900">
            {password}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(password);
              setCopied(true);
            }}
            className="rounded px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
        >
          Done
        </button>
      </div>
    </div>
  );
}
