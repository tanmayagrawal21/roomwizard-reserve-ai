/**
 * Seven-day navigator with a density bar per day.
 *
 * The original interface shows one day and makes you arrow through the week
 * blindly. Seeing at a glance that Thursday is packed and Friday is empty is
 * the single biggest thing it was missing.
 */

import { dateParts, isWeekend } from "../lib/time";

interface Props {
  days: string[];
  selected: string;
  today: string;
  /** date -> 0..1 share of the bookable day already booked. */
  utilization: Record<string, number>;
  onSelect: (date: string) => void;
}

export function WeekStrip({ days, selected, today, utilization, onSelect }: Props) {
  return (
    <div className="flex gap-1">
      {days.map((date) => {
        const { weekday, day } = dateParts(date);
        const isSelected = date === selected;
        const util = utilization[date];
        return (
          <button
            key={date}
            type="button"
            onClick={() => onSelect(date)}
            aria-current={isSelected ? "date" : undefined}
            className={
              "group flex-1 rounded-md px-1 py-1.5 text-center transition-colors " +
              (isSelected
                ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                : "hover:bg-slate-100 dark:hover:bg-slate-800")
            }
          >
            <div
              className={
                "text-[10px] font-medium " +
                (isSelected
                  ? "text-white/70 dark:text-slate-900/60"
                  : date === today
                    ? "text-rose-500 dark:text-rose-400"
                    : isWeekend(date)
                      ? "text-slate-300 dark:text-slate-600"
                      : "text-slate-400 dark:text-slate-500")
              }
            >
              {date === today ? "Today" : weekday}
            </div>
            <div className="text-sm leading-tight font-semibold tabular-nums">{day}</div>
            {/* Density bar. Undefined utilization means not loaded yet, which
                must not look like an empty day. */}
            <div
              className={
                "mt-1 h-1 overflow-hidden rounded-full " +
                (isSelected ? "bg-white/25 dark:bg-slate-900/20" : "bg-slate-200 dark:bg-slate-700")
              }
            >
              {util !== undefined && (
                <div
                  className={
                    "h-full rounded-full " +
                    (isSelected
                      ? "bg-white/80 dark:bg-slate-900/70"
                      : util > 0.66
                        ? "bg-rose-400"
                        : util > 0.33
                          ? "bg-amber-400"
                          : "bg-emerald-400")
                  }
                  style={{ width: `${Math.max(util * 100, util > 0 ? 6 : 0)}%` }}
                  title={`${Math.round(util * 100)}% booked`}
                />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
