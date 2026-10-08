/**
 * Detail view for an existing booking, opened by clicking its block on a
 * timeline. Also where editing and cancelling happen — not a separate form
 * elsewhere, since both need the same thing this pane already establishes:
 * proof of the booking's password.
 *
 * Everything shown in the "view" state is already visible to anyone, logged
 * in or not — the appliance has no authentication, so a room's full schedule
 * is public by construction. Editing and cancelling are different: the
 * appliance hides a booking's real fields from anyone who hasn't supplied its
 * password, even on its own edit page (verified live — see `booking.ts` on
 * the relay). That is the actual security boundary here, not whether this
 * browser's local storage happens to recognize the booking.
 *
 * A booking this browser created shows a plain "Edit" — the password is
 * already in local storage, so there is nothing to ask. Any other booking
 * shows "Edit 🔒": clicking it asks for the password, with an option to
 * remember it here afterward, converting an unrecognized booking into one
 * this browser can edit directly next time.
 */

import { useState } from "react";
import {
  RelayError,
  cancelBooking,
  unlockBooking,
  updateBooking,
  type Booking,
  type Room,
} from "../api";
import { addMyBooking, listMyBookings, removeMyBooking } from "../lib/myBookings";
import { formatDuration, formatTime, minuteTo12h, minuteToClock, minutesOfDay } from "../lib/time";
import { BookingFields } from "./BookingFields";

interface Props {
  room: Room;
  booking: Booking;
  timeZone: string;
  dayEndHour: number;
  onClose: () => void;
  /** A save or cancel changed something the week view needs to refetch. */
  onChanged: () => void;
}

type View =
  | { kind: "details" }
  | { kind: "unlock"; password: string; remember: boolean; submitting: boolean; error: string | null }
  | {
      kind: "edit";
      password: string;
      remember: boolean;
      purpose: string;
      firstName: string;
      lastName: string;
      email: string;
      duration: number;
      submitting: "save" | "delete" | null;
      error: string | null;
    };

export function BookingPreview({ room, booking, timeZone, dayEndHour, onClose, onChanged }: Props) {
  const tracked = listMyBookings().find((b) => b.roomId === room.id && b.id === booking.id);
  const isMine = tracked !== undefined;
  const [view, setView] = useState<View>({ kind: "details" });

  const originalStartMinute = minutesOfDay(booking.start, timeZone);
  const maxDuration = Math.max(15, dayEndHour * 60 - originalStartMinute);
  const date = booking.start.slice(0, 10);

  function startEditing(password: string, remember: boolean, fields: {
    purpose: string;
    hostFirstName: string;
    hostLastName: string;
    hostEmail: string;
    start: string;
  }) {
    const durationMinutes = Math.round(
      (new Date(booking.end).getTime() - new Date(fields.start).getTime()) / 60_000,
    );
    setView({
      kind: "edit",
      password,
      remember,
      purpose: fields.purpose,
      firstName: fields.hostFirstName,
      lastName: fields.hostLastName,
      email: fields.hostEmail,
      duration: Math.max(15, durationMinutes || 30),
      submitting: null,
      error: null,
    });
  }

  async function beginEditAsMine() {
    if (!tracked) return;
    setView({ kind: "unlock", password: tracked.password, remember: false, submitting: true, error: null });
    try {
      const fields = await unlockBooking(room.id, booking.id, tracked.password);
      startEditing(tracked.password, false, fields);
    } catch (err) {
      // The stored password should always work for a tracked booking; if it
      // doesn't, something is out of sync (edited elsewhere, say), and the
      // honest move is to fall through to asking like any unrecognized one.
      setView({ kind: "unlock", password: "", remember: true, submitting: false, error: null });
    }
  }

  async function submitUnlock() {
    if (view.kind !== "unlock" || !view.password) return;
    setView({ ...view, submitting: true, error: null });
    try {
      const fields = await unlockBooking(room.id, booking.id, view.password);
      if (view.remember) {
        addMyBooking({
          id: booking.id,
          roomId: room.id,
          roomName: room.name,
          start: fields.start,
          end: fields.end,
          purpose: fields.purpose,
          password: view.password,
          createdAt: new Date().toISOString(),
        });
      }
      startEditing(view.password, view.remember, fields);
    } catch (err) {
      setView({
        ...view,
        submitting: false,
        error: err instanceof RelayError ? err.message : "Couldn't check that password.",
      });
    }
  }

  async function submitSave() {
    if (view.kind !== "edit") return;
    setView({ ...view, submitting: "save", error: null });
    try {
      const start = `${date}T${minuteToClock(originalStartMinute)}:00`;
      const end = `${date}T${minuteToClock(originalStartMinute + view.duration)}:00`;
      await updateBooking(room.id, booking.id, {
        roomId: room.id,
        start,
        end,
        purpose: view.purpose.trim(),
        hostFirstName: view.firstName.trim(),
        hostLastName: view.lastName.trim(),
        hostEmail: view.email.trim() || undefined,
        currentPassword: view.password,
      });
      onChanged();
      onClose();
    } catch (err) {
      setView({
        ...view,
        submitting: null,
        error: err instanceof RelayError ? err.message : "Couldn't save that.",
      });
    }
  }

  async function submitDelete() {
    if (view.kind !== "edit") return;
    setView({ ...view, submitting: "delete", error: null });
    try {
      await cancelBooking(room.id, booking.id, view.password);
      removeMyBooking(room.id, booking.id);
      onChanged();
      onClose();
    } catch (err) {
      setView({
        ...view,
        submitting: null,
        error: err instanceof RelayError ? err.message : "Couldn't cancel that.",
      });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-20 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{room.name}</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {view.kind === "edit"
            ? `${minuteTo12h(originalStartMinute)} – ${minuteTo12h(originalStartMinute + view.duration)}`
            : `${formatTime(booking.start, timeZone)} – ${formatTime(booking.end, timeZone)} · ${formatDuration(booking.start, booking.end)}`}
        </p>

        {view.kind === "details" && (
          <>
            {booking.isConfidential ? (
              <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700">
                Marked private — the host chose not to share details for this booking.
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm font-medium text-slate-800 dark:text-slate-100">
                  {booking.purpose || "(no purpose given)"}
                </p>
                {(booking.host || booking.hostEmail) && (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Booked by {booking.host || "someone who didn't give a name"}
                    {booking.hostEmail && (
                      <>
                        {" "}
                        &middot;{" "}
                        <a
                          href={`mailto:${booking.hostEmail}`}
                          className="font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                        >
                          {booking.hostEmail}
                        </a>
                      </>
                    )}
                  </p>
                )}
              </>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() =>
                  isMine
                    ? beginEditAsMine()
                    : setView({ kind: "unlock", password: "", remember: true, submitting: false, error: null })
                }
                className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
              >
                {isMine ? "Edit" : "Edit 🔒"}
              </button>
            </div>
          </>
        )}

        {view.kind === "unlock" && (
          <div className="mt-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              This browser doesn't recognize this booking. Enter its password to edit or cancel
              it.
            </p>
            <input
              type="password"
              autoFocus
              value={view.password}
              onChange={(e) => setView({ ...view, password: e.target.value, error: null })}
              onKeyDown={(e) => e.key === "Enter" && submitUnlock()}
              placeholder="Booking password"
              className="mt-2 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={view.remember}
                onChange={(e) => setView({ ...view, remember: e.target.checked })}
              />
              Remember this as mine on this browser
            </label>
            {view.error && (
              <p className="mt-2 rounded-md bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
                {view.error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setView({ kind: "details" })}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Back
              </button>
              <button
                type="button"
                onClick={submitUnlock}
                disabled={!view.password || view.submitting}
                className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
              >
                {view.submitting ? "Checking…" : "Continue"}
              </button>
            </div>
          </div>
        )}

        {view.kind === "edit" && (
          <>
            <BookingFields
              purpose={view.purpose}
              onPurposeChange={(v) => setView({ ...view, purpose: v })}
              firstName={view.firstName}
              onFirstNameChange={(v) => setView({ ...view, firstName: v })}
              lastName={view.lastName}
              onLastNameChange={(v) => setView({ ...view, lastName: v })}
              email={view.email}
              onEmailChange={(v) => setView({ ...view, email: v })}
              duration={view.duration}
              onDurationChange={(d) => setView({ ...view, duration: d })}
              maxDuration={maxDuration}
              error={view.error}
            />
            <div className="mt-4 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={submitDelete}
                disabled={view.submitting !== null}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
              >
                {view.submitting === "delete" ? "Cancelling…" : "Cancel booking"}
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={submitSave}
                  disabled={
                    view.submitting !== null ||
                    view.purpose.trim() === "" ||
                    (view.firstName.trim() === "" && view.lastName.trim() === "")
                  }
                  className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
                >
                  {view.submitting === "save" ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
