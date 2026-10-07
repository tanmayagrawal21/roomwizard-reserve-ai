/**
 * One room's day as a horizontal timeline.
 *
 * Booked blocks are positioned by percentage across the bookable window, so the
 * row reflows at any width without recalculating anything. Free gaps are the
 * background, which inverts the original RoomWizard's emphasis: you are looking
 * for somewhere to be, so empty space should read as the opportunity, not the
 * absence of data.
 */

import type { Booking, RoomAvailability } from "../api";
import { formatDuration, formatTime, minutesOfDay } from "../lib/time";

interface Props {
  entry: RoomAvailability;
  dayStartHour: number;
  dayEndHour: number;
  timeZone: string;
  /** Minutes from midnight, or null when not viewing today. */
  nowMinutes: number | null;
}

export function Timeline({ entry, dayStartHour, dayEndHour, timeZone, nowMinutes }: Props) {
  const windowStart = dayStartHour * 60;
  const windowEnd = dayEndHour * 60;
  const span = windowEnd - windowStart;

  const toPercent = (minutes: number) =>
    ((Math.min(Math.max(minutes, windowStart), windowEnd) - windowStart) / span) * 100;

  const blockFor = (b: Booking) => {
    // A booking may start before or end after the bookable window; clamping
    // keeps the block inside the track instead of overflowing the row.
    const rawStart = minutesOfDay(b.start, timeZone);
    const rawEnd = minutesOfDay(b.end, timeZone);
    // An end of exactly midnight reads as 0; treat it as the end of the day.
    const end = rawEnd === 0 && rawStart > 0 ? 24 * 60 : rawEnd;
    const left = toPercent(rawStart);
    const width = Math.max(toPercent(end) - left, 0.6);
    return { left, width };
  };

  return (
    <div className="relative h-11 rounded-md bg-emerald-50 ring-1 ring-inset ring-emerald-200/70 dark:bg-emerald-950/40 dark:ring-emerald-900/60">
      {/* Hour gridlines, so a block's position is readable without a tooltip. */}
      {Array.from({ length: dayEndHour - dayStartHour - 1 }, (_, i) => (
        <div
          key={i}
          className="absolute top-0 bottom-0 w-px bg-emerald-200/60 dark:bg-emerald-900/50"
          style={{ left: `${((i + 1) / (dayEndHour - dayStartHour)) * 100}%` }}
        />
      ))}

      {entry.busy.map((b) => {
        const { left, width } = blockFor(b);
        const label = b.isConfidential ? "Private booking" : (b.purpose ?? "Booked");
        const who = b.host ? ` — ${b.host}` : "";
        return (
          <div
            key={b.id}
            className="group absolute top-0.5 bottom-0.5 overflow-hidden rounded bg-slate-500/90 px-1.5 ring-1 ring-inset ring-slate-600/40 transition-colors hover:bg-slate-600 dark:bg-slate-600/90 dark:hover:bg-slate-500"
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${label}${who}\n${formatTime(b.start, timeZone)} – ${formatTime(b.end, timeZone)} (${formatDuration(b.start, b.end)})`}
          >
            <span className="block truncate pt-1.5 text-[11px] leading-none font-medium text-white/95">
              {label}
            </span>
            <span className="block truncate text-[10px] leading-tight text-white/70">
              {formatTime(b.start, timeZone)}
            </span>
          </div>
        );
      })}

      {nowMinutes !== null && nowMinutes >= windowStart && nowMinutes <= windowEnd && (
        <div
          className="pointer-events-none absolute -top-1 -bottom-1 z-10 w-0.5 bg-rose-500"
          style={{ left: `${toPercent(nowMinutes)}%` }}
          title="Now"
        >
          <div className="absolute -top-1 -left-[3px] size-2 rounded-full bg-rose-500" />
        </div>
      )}
    </div>
  );
}

/** Shared hour axis above the rows. */
export function HourAxis({ dayStartHour, dayEndHour }: { dayStartHour: number; dayEndHour: number }) {
  const hours = Array.from({ length: dayEndHour - dayStartHour }, (_, i) => dayStartHour + i);
  return (
    <div className="relative h-5 select-none">
      {hours.map((h, i) => (
        <div
          key={h}
          className="absolute text-[10px] font-medium text-slate-400 tabular-nums dark:text-slate-500"
          style={{ left: `${(i / hours.length) * 100}%` }}
        >
          {h % 12 === 0 ? 12 : h % 12}
          {h === dayStartHour || h === 12 ? (h < 12 ? "am" : "pm") : ""}
        </div>
      ))}
    </div>
  );
}
