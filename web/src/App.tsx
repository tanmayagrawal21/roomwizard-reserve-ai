import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAvailability,
  fetchFleet,
  getRelayUrl,
  RelayError,
  type AvailabilityResult,
  type Booking,
  type Room,
} from "./api";
import { BookingModal } from "./components/BookingModal";
import { BookingPreview } from "./components/BookingPreview";
import { FilterBar } from "./components/FilterBar";
import { MyBookingsPanel } from "./components/MyBookingsPanel";
import { RelaySettings } from "./components/RelaySettings";
import { RoomErrorRow, RoomRow } from "./components/RoomRow";
import { HourAxis } from "./components/Timeline";
import { WeekStrip } from "./components/WeekStrip";
import { dayUtilization, EMPTY_FILTERS, matchesFilters, type Filters } from "./lib/filters";
import { listMyBookings, pruneExpired, type TrackedBooking } from "./lib/myBookings";
import {
  addDaysToDate,
  formatDateLabel,
  minutesOfDay,
  todayInZone,
} from "./lib/time";

/** Days fetched in one request, so the week strip can show density. */
const WINDOW_DAYS = 7;

export default function App() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showSettings, setShowSettings] = useState(false);
  const [showMyBookings, setShowMyBookings] = useState(false);
  const [selection, setSelection] = useState<{ room: Room; minute: number } | null>(null);
  const [preview, setPreview] = useState<{ room: Room; booking: Booking } | null>(null);
  const [myBookings, setMyBookings] = useState<TrackedBooking[]>(() => listMyBookings());
  /** Monday-agnostic: the window simply starts at the anchor date. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    pruneExpired(new Date().toISOString());
    setMyBookings(listMyBookings());
  }, []);

  function afterBookingChange() {
    setMyBookings(listMyBookings());
    // Both queries key off the same bookings; a create or cancel can affect
    // either the currently-viewed window or the week strip's density bars.
    void queryClient.invalidateQueries({ queryKey: ["availability"] });
  }

  const fleetQuery = useQuery({
    queryKey: ["fleet", getRelayUrl()],
    queryFn: ({ signal }) => fetchFleet(signal),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  const timeZone = fleetQuery.data?.timezone ?? "UTC";
  const today = useMemo(
    () => (fleetQuery.data ? todayInZone(timeZone) : null),
    [fleetQuery.data, timeZone],
  );

  // Anchor the window on the fleet's today, not the browser's.
  const windowStart = anchor ?? today;
  const selectedDate = selected ?? today;

  const availabilityQuery = useQuery({
    queryKey: ["availability", getRelayUrl(), windowStart],
    queryFn: ({ signal }) => fetchAvailability(windowStart!, WINDOW_DAYS, signal),
    enabled: windowStart !== null,
    // Matches the relay's own booking cache, so the UI is never showing
    // something staler than the relay would serve anyway.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const days = useMemo(
    () =>
      windowStart
        ? Array.from({ length: WINDOW_DAYS }, (_, i) => addDaysToDate(windowStart, i))
        : [],
    [windowStart],
  );

  const fleetMeta = availabilityQuery.data?.fleet ?? fleetQuery.data;
  const dayStartHour = fleetMeta?.dayStartHour ?? 7;
  const dayEndHour = fleetMeta?.dayEndHour ?? 19;

  /** Split the multi-day payload into per-day slices. */
  const byDay = useMemo(
    () => splitByDay(availabilityQuery.data, days, timeZone),
    [availabilityQuery.data, days, timeZone],
  );

  const utilization = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [date, entries] of Object.entries(byDay)) {
      out[date] = dayUtilization(entries, dayStartHour, dayEndHour);
    }
    return out;
  }, [byDay, dayStartHour, dayEndHour]);

  const dayEntries = (selectedDate && byDay[selectedDate]) || [];
  const visible = dayEntries.filter((e) => matchesFilters(e, filters));

  const floors = useMemo(
    () =>
      [...new Set(dayEntries.map((e) => e.room.floor).filter((f): f is number => f !== null))].sort(
        (a, b) => a - b,
      ),
    [dayEntries],
  );
  const capacities = useMemo(
    () => [...new Set(dayEntries.map((e) => e.room.capacity))].sort((a, b) => a - b),
    [dayEntries],
  );

  const nowMinutes =
    selectedDate && today && selectedDate === today
      ? minutesOfDay(new Date().toISOString(), timeZone)
      : null;

  const error = fleetQuery.error ?? availabilityQuery.error;

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          {fleetQuery.data?.site ?? "Rooms"}
        </h1>
        {fleetMeta && (
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            {dayStartHour}:00&ndash;{dayEndHour}:00 &middot; {timeZone.replace("_", " ")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {availabilityQuery.isFetching && (
            <span className="text-[11px] text-slate-400 dark:text-slate-500">updating…</span>
          )}
          <button
            type="button"
            onClick={() => availabilityQuery.refetch()}
            className="rounded px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowMyBookings(true)}
            className="rounded px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            My bookings{myBookings.length > 0 ? ` (${myBookings.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="rounded px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            Relay
          </button>
        </div>
      </header>

      {error ? (
        <ErrorPanel error={error} onOpenSettings={() => setShowSettings(true)} />
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <NavButton
              onClick={() => {
                const next = addDaysToDate(windowStart ?? today!, -WINDOW_DAYS);
                setAnchor(next);
                setSelected(next);
              }}
              label="Previous week"
            >
              &larr;
            </NavButton>
            <div className="min-w-0 flex-1">
              {windowStart && today && selectedDate && (
                <WeekStrip
                  days={days}
                  selected={selectedDate}
                  today={today}
                  utilization={utilization}
                  onSelect={setSelected}
                />
              )}
            </div>
            <NavButton
              onClick={() => {
                const next = addDaysToDate(windowStart ?? today!, WINDOW_DAYS);
                setAnchor(next);
                setSelected(next);
              }}
              label="Next week"
            >
              &rarr;
            </NavButton>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              {selectedDate ? formatDateLabel(selectedDate) : " "}
            </h2>
            {selectedDate && today && selectedDate !== today && (
              <button
                type="button"
                onClick={() => {
                  setAnchor(today);
                  setSelected(today);
                }}
                className="text-[11px] font-medium text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
              >
                back to today
              </button>
            )}
          </div>

          <div className="mt-3 border-y border-slate-200 py-2.5 dark:border-slate-800">
            <FilterBar
              filters={filters}
              onChange={setFilters}
              floors={floors}
              capacities={capacities}
              matched={visible.length}
              total={dayEntries.length}
            />
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {availabilityQuery.isPending ? (
              <SkeletonRows />
            ) : (
              <>
                <div className="grid grid-cols-[minmax(8rem,11rem)_1fr] gap-3 sm:gap-4">
                  <div />
                  <HourAxis dayStartHour={dayStartHour} dayEndHour={dayEndHour} />
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
                  {visible.map((entry) => (
                    <RoomRow
                      key={entry.room.id}
                      entry={entry}
                      dayStartHour={dayStartHour}
                      dayEndHour={dayEndHour}
                      timeZone={timeZone}
                      nowMinutes={nowMinutes}
                      slotMinutes={fleetMeta?.slotMinutes ?? 15}
                      onSelectSlot={
                        selectedDate && selectedDate >= today!
                          ? (room, minute) => setSelection({ room, minute })
                          : undefined
                      }
                      onPreviewBooking={(room, booking) => setPreview({ room, booking })}
                    />
                  ))}
                  {availabilityQuery.data?.errors.map((e) => (
                    <RoomErrorRow key={e.roomId} roomId={e.roomId} message={e.message} />
                  ))}
                </div>
                {visible.length === 0 && dayEntries.length > 0 && (
                  <p className="py-10 text-center text-xs text-slate-400 dark:text-slate-500">
                    No rooms match these filters.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}

      {showSettings && <RelaySettings onClose={() => setShowSettings(false)} />}

      {showMyBookings && (
        <MyBookingsPanel
          bookings={myBookings}
          onClose={() => setShowMyBookings(false)}
          onChanged={afterBookingChange}
        />
      )}

      {selection && selectedDate && (
        <BookingModal
          room={selection.room}
          date={selectedDate}
          startMinute={selection.minute}
          dayEndHour={dayEndHour}
          slotMinutes={fleetMeta?.slotMinutes ?? 15}
          onClose={() => setSelection(null)}
          onBooked={afterBookingChange}
        />
      )}

      {preview && (
        <BookingPreview
          room={preview.room}
          booking={preview.booking}
          timeZone={timeZone}
          dayEndHour={dayEndHour}
          onClose={() => setPreview(null)}
          onChanged={afterBookingChange}
        />
      )}
    </div>
  );
}

/**
 * The relay returns one flat list per room covering the whole window. The day
 * view needs each day separately, so bookings and gaps are bucketed by their
 * local calendar date.
 */
function splitByDay(
  data: AvailabilityResult | undefined,
  days: string[],
  timeZone: string,
): Record<string, AvailabilityResult["rooms"]> {
  const out: Record<string, AvailabilityResult["rooms"]> = {};
  if (!data) return out;

  const dateOf = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));

  for (const date of days) {
    out[date] = data.rooms.map((entry) => ({
      room: entry.room,
      busy: entry.busy.filter((b) => dateOf(b.start) === date),
      free: entry.free.filter((g) => dateOf(g.start) === date),
    }));
  }
  return out;
}

function NavButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md px-2 py-3 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="grid grid-cols-[minmax(8rem,11rem)_1fr] gap-3 py-2 sm:gap-4">
          <div className="space-y-1.5 py-0.5">
            <div className="h-3.5 w-20 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-2.5 w-14 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
          </div>
          <div className="h-11 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800/60" />
        </div>
      ))}
    </div>
  );
}

function ErrorPanel({
  error,
  onOpenSettings,
}: {
  error: unknown;
  onOpenSettings: () => void;
}) {
  const isNetwork = error instanceof RelayError && error.isNetwork;
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="mt-8 rounded-lg bg-amber-50 p-5 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-900/60">
      <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
        {isNetwork ? "Can't reach the relay" : "The relay returned an error"}
      </h2>
      <p className="mt-1.5 font-mono text-[11px] text-amber-800/80 dark:text-amber-300/80">
        {message}
      </p>
      {isNetwork && (
        <div className="mt-3 space-y-1.5 text-xs text-amber-900/90 dark:text-amber-200/90">
          <p>Three things to check, in order of likelihood:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              The relay isn't running. Start it with{" "}
              <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">
                npm run dev
              </code>
              .
            </li>
            <li>
              You're not on the building's network. The room appliances use private
              addresses, so the relay needs to be on that network or its VPN.
            </li>
            <li>
              The relay is somewhere else &mdash;{" "}
              <button
                type="button"
                onClick={onOpenSettings}
                className="font-medium underline underline-offset-2"
              >
                change its address
              </button>
              .
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
