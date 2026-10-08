/**
 * Time helpers for the UI.
 *
 * The relay sends ISO strings with an explicit offset, which `new Date()` parses
 * correctly. But the browser's own timezone is irrelevant and actively
 * misleading here: a user on a laptop still set to Eastern should see the
 * building's hours, not theirs. So anything user-facing is formatted in the
 * fleet's timezone, which the relay reports.
 */

/** Minutes from local midnight, in the given timezone. */
export function minutesOfDay(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** `2:30 pm` in the fleet's timezone. */
export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(iso))
    .toLowerCase()
    .replace(/\s/g, " ");
}

/** `2 pm`, dropping `:00` for a clean axis. */
export function formatHour(hour: number): string {
  const h = hour % 24;
  const suffix = h < 12 ? "am" : "pm";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display} ${suffix}`;
}

/** Duration like `1h 30m`, `45m`, `2h`. */
export function formatDuration(startIso: string, endIso: string): string {
  const mins = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
  );
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Calendar dates, as `YYYY-MM-DD` strings
// ---------------------------------------------------------------------------

/** Today's date in the fleet's timezone, not the browser's. */
export function todayInZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Shift a `YYYYMMDD`-style date string by whole days.
 *
 * Uses UTC arithmetic deliberately: these are calendar labels, not instants, so
 * no timezone is involved and `Date.UTC` can't drift across a DST boundary the
 * way local-time arithmetic would.
 */
export function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return shifted.toISOString().slice(0, 10);
}

/** `Wed 8 Oct` — compact, unambiguous, no locale surprises. */
export function formatDateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  const weekday = dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const month = dt.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${weekday} ${d} ${month}`;
}

/** `Wed` / `8` for the compact week strip. */
export function dateParts(date: string): { weekday: string; day: number } {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return {
    weekday: dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
    day: d!,
  };
}

export function isWeekend(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return dow === 0 || dow === 6;
}

// ---------------------------------------------------------------------------
// Minute-of-day <-> clock string, for the booking create/edit forms
// ---------------------------------------------------------------------------

const padMinute = (n: number) => String(n).padStart(2, "0");

/** 990 -> "16:30", for building a naive local datetime string. */
export function minuteToClock(minute: number): string {
  return `${padMinute(Math.floor(minute / 60) % 24)}:${padMinute(minute % 60)}`;
}

/** 990 -> "4:30 pm", for display. */
export function minuteTo12h(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const suffix = h < 12 ? "am" : "pm";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${padMinute(m)} ${suffix}`;
}
