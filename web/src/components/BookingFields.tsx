/**
 * The time/purpose/name/email fields shared by creating a booking
 * (BookingModal) and editing one (BookingPreview's edit view).
 *
 * End time is the single source of truth rather than a duration: the duration
 * chips are a shortcut for setting it, and "Custom" exposes it directly. Only
 * end times the relay will actually accept are offered — see `lib/slots.ts`
 * for the four ceilings that decides.
 */

import { minuteTo12h } from "../lib/time";

/** Shortcut durations, in minutes. Filtered to those that fit before display. */
export const PREFERRED_DURATIONS = [15, 30, 45, 60, 90, 120];

export function formatDurationChip(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

interface Props {
  startMinute: number;
  endMinute: number;
  onEndMinuteChange: (endMinute: number) => void;
  /** Every end time the relay will accept, ascending. Empty means nothing fits. */
  allowedEnds: number[];
  /** Shortcut durations that fit, in minutes. */
  fittingDurations: number[];
  custom: boolean;
  onCustomChange: (custom: boolean) => void;

  purpose: string;
  onPurposeChange: (v: string) => void;
  firstName: string;
  onFirstNameChange: (v: string) => void;
  lastName: string;
  onLastNameChange: (v: string) => void;
  email: string;
  onEmailChange: (v: string) => void;
  error: string | null;
}

export function BookingFields({
  startMinute,
  endMinute,
  onEndMinuteChange,
  allowedEnds,
  fittingDurations,
  custom,
  onCustomChange,
  purpose,
  onPurposeChange,
  firstName,
  onFirstNameChange,
  lastName,
  onLastNameChange,
  email,
  onEmailChange,
  error,
}: Props) {
  const duration = endMinute - startMinute;
  const latestEnd = allowedEnds.length > 0 ? allowedEnds[allowedEnds.length - 1]! : endMinute;

  return (
    <>
      <div className="mt-3 flex items-baseline justify-between">
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          Ends at
        </label>
        <button
          type="button"
          onClick={() => onCustomChange(!custom)}
          className="text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
        >
          {custom ? "Use presets" : "Custom time"}
        </button>
      </div>

      {custom ? (
        <>
          <select
            value={endMinute}
            onChange={(e) => onEndMinuteChange(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            {allowedEnds.map((m) => (
              <option key={m} value={m}>
                {minuteTo12h(m)} ({formatDurationChip(m - startMinute)})
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            Latest available here is {minuteTo12h(latestEnd)} — limited by the next booking,
            the end of the bookable day, or the longest booking allowed, whichever comes
            first.
          </p>
        </>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1">
          {fittingDurations.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onEndMinuteChange(startMinute + d)}
              aria-pressed={duration === d}
              className={
                "rounded-full px-2 py-0.5 text-xs font-medium transition-colors " +
                (duration === d
                  ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700")
              }
            >
              {formatDurationChip(d)}
            </button>
          ))}
          {/* A duration set via the custom picker won't match any chip; show it
              so the current selection is never invisible. */}
          {!fittingDurations.includes(duration) && (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-white dark:bg-slate-200 dark:text-slate-900">
              {formatDurationChip(duration)}
            </span>
          )}
        </div>
      )}

      <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">
        What's this for?
      </label>
      <input
        type="text"
        value={purpose}
        onChange={(e) => onPurposeChange(e.target.value)}
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
            onChange={(e) => onFirstNameChange(e.target.value)}
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
            onChange={(e) => onLastNameChange(e.target.value)}
            maxLength={50}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </div>
      </div>

      <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">
        Email <span className="font-normal text-slate-400">(optional)</span>
      </label>
      <input
        type="email"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        maxLength={100}
        placeholder="you@arizona.edu"
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      />
      <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
        Shown to anyone who views this room's schedule, so they know who to contact — same as
        your name already is. Leave blank to skip.
      </p>

      {error && (
        <p className="mt-3 rounded-md bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
          {error}
        </p>
      )}
    </>
  );
}
