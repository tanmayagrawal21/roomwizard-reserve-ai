/**
 * The purpose/name/email/duration fields shared by creating a booking
 * (BookingModal) and editing one (BookingPreview's edit view). Pulled out
 * once two forms needed the identical fields rather than drift apart.
 */

export const DURATIONS = [15, 30, 45, 60, 90, 120];

export function formatDurationChip(d: number): string {
  if (d < 60) return `${d}m`;
  return d % 60 === 0 ? `${d / 60}h` : `${Math.floor(d / 60)}h${d % 60}m`;
}

interface Props {
  purpose: string;
  onPurposeChange: (v: string) => void;
  firstName: string;
  onFirstNameChange: (v: string) => void;
  lastName: string;
  onLastNameChange: (v: string) => void;
  email: string;
  onEmailChange: (v: string) => void;
  duration: number;
  onDurationChange: (d: number) => void;
  maxDuration: number;
  error: string | null;
}

export function BookingFields({
  purpose,
  onPurposeChange,
  firstName,
  onFirstNameChange,
  lastName,
  onLastNameChange,
  email,
  onEmailChange,
  duration,
  onDurationChange,
  maxDuration,
  error,
}: Props) {
  return (
    <>
      <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">
        Duration
      </label>
      <div className="mt-1 flex flex-wrap gap-1">
        {DURATIONS.filter((d) => d <= maxDuration).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onDurationChange(d)}
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
      </div>

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
