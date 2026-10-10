/**
 * "Find me a slot": say how long and what you need, get a ranked shortlist.
 *
 * The ranking is entirely server-side and deterministic (relay `slots.ts`), so
 * this panel is a thin presenter — including the `reasons` strings, which it
 * renders verbatim. That is deliberate: the same endpoint becomes the Phase 5
 * LLM tool, and a recommendation the chat can explain has to be explainable
 * here too, from the same words.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { findSlots, getRelayUrl, RelayError, type Amenity, type SlotCandidate } from "../api";
import { AMENITY_LABELS } from "../lib/filters";
import { formatDateLabel } from "../lib/time";
import { formatDurationChip } from "./BookingFields";

interface Props {
  timeZone: string;
  onClose: () => void;
  /** Book this candidate — hands off to the normal booking modal. */
  onPick: (candidate: SlotCandidate) => void;
}

const DURATIONS = [30, 60, 90, 120, 180];
const WINDOWS = [
  { label: "Any time", earliest: undefined, latest: undefined },
  { label: "Morning", earliest: 7, latest: 12 },
  { label: "Afternoon", earliest: 12, latest: 17 },
  { label: "Late day", earliest: 16, latest: 19 },
];
const RANGES = [
  { label: "Today", days: 1 },
  { label: "3 days", days: 3 },
  { label: "This week", days: 7 },
  { label: "2 weeks", days: 14 },
];

export function SlotFinder({ timeZone, onClose, onPick }: Props) {
  const [duration, setDuration] = useState(60);
  const [days, setDays] = useState(7);
  const [minCapacity, setMinCapacity] = useState<number | undefined>(undefined);
  const [amenities, setAmenities] = useState<Amenity[]>([]);
  const [windowIdx, setWindowIdx] = useState(0);

  const win = WINDOWS[windowIdx]!;
  const search = {
    duration,
    days,
    ...(minCapacity !== undefined ? { minCapacity } : {}),
    amenities,
    ...(win.earliest !== undefined ? { earliestHour: win.earliest } : {}),
    ...(win.latest !== undefined ? { latestHour: win.latest } : {}),
  };

  const query = useQuery({
    queryKey: ["slots", getRelayUrl(), search],
    queryFn: ({ signal }) => findSlots(search, signal),
    staleTime: 30 * 1000,
    retry: 1,
  });

  const toggleAmenity = (a: Amenity) =>
    setAmenities((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-16 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-lg bg-white p-5 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Find a slot</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            Close
          </button>
        </div>

        <div className="mt-3 space-y-2.5 text-xs">
          <Row label="For">
            {DURATIONS.map((d) => (
              <Chip key={d} active={duration === d} onClick={() => setDuration(d)}>
                {formatDurationChip(d)}
              </Chip>
            ))}
          </Row>
          <Row label="When">
            {WINDOWS.map((w, i) => (
              <Chip key={w.label} active={windowIdx === i} onClick={() => setWindowIdx(i)}>
                {w.label}
              </Chip>
            ))}
          </Row>
          <Row label="Within">
            {RANGES.map((r) => (
              <Chip key={r.days} active={days === r.days} onClick={() => setDays(r.days)}>
                {r.label}
              </Chip>
            ))}
          </Row>
          <Row label="Seats">
            <Chip active={minCapacity === undefined} onClick={() => setMinCapacity(undefined)}>
              any
            </Chip>
            {[4, 6, 8, 10].map((n) => (
              <Chip key={n} active={minCapacity === n} onClick={() => setMinCapacity(n)}>
                {n}+
              </Chip>
            ))}
          </Row>
          <Row label="Needs">
            {(Object.keys(AMENITY_LABELS) as Amenity[]).map((a) => (
              <Chip key={a} active={amenities.includes(a)} onClick={() => toggleAmenity(a)}>
                {AMENITY_LABELS[a]}
              </Chip>
            ))}
          </Row>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-slate-100 pt-3 dark:border-slate-800">
          {query.isPending ? (
            <p className="py-6 text-center text-xs text-slate-400 dark:text-slate-500">
              Searching…
            </p>
          ) : query.error ? (
            <p className="rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/60">
              {query.error instanceof RelayError ? query.error.message : "Couldn't search."}
            </p>
          ) : query.data!.candidates.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
              {query.data!.noMatchReason ?? "Nothing matches those requirements."}
            </p>
          ) : (
            <>
              <p className="mb-2 text-[11px] text-slate-400 dark:text-slate-500">
                Best {query.data!.candidates.length} of {query.data!.totalFound} openings
              </p>
              <ul className="space-y-1.5">
                {query.data!.candidates.map((c) => (
                  <li key={`${c.roomId}:${c.start}`}>
                    <button
                      type="button"
                      onClick={() => onPick(c)}
                      className="w-full rounded-md border border-slate-200 px-3 py-2 text-left transition-colors hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-slate-500 dark:hover:bg-slate-800/60"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                          {c.roomName}
                        </span>
                        <span className="text-xs text-slate-600 tabular-nums dark:text-slate-300">
                          {formatDateLabel(c.start.slice(0, 10))}, {hhmm(c.start, timeZone)}&ndash;
                          {hhmm(c.end, timeZone)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500 dark:text-slate-400">
                        <span className="tabular-nums">{c.capacity} seats</span>
                        {c.floor !== null && <span>floor {c.floor}</span>}
                        {c.amenities.length > 0 && <span>{c.amenities.map((a) => AMENITY_LABELS[a]).join(", ")}</span>}
                      </div>
                      {c.reasons.length > 0 && (
                        <p className="mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                          {c.reasons.join(" · ")}
                        </p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function hhmm(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(iso))
    .toLowerCase();
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 w-12 shrink-0 text-slate-400 dark:text-slate-500">{label}</span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-full px-2 py-0.5 font-medium transition-colors " +
        (active
          ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700")
      }
    >
      {children}
    </button>
  );
}
