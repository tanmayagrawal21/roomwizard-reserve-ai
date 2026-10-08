import type { Booking, Room, RoomAvailability } from "../api";
import { AMENITY_LABELS, longestFreeMinutes } from "../lib/filters";
import { formatDuration, formatTime } from "../lib/time";
import { Timeline } from "./Timeline";

interface Props {
  entry: RoomAvailability;
  dayStartHour: number;
  dayEndHour: number;
  timeZone: string;
  nowMinutes: number | null;
  slotMinutes: number;
  onSelectSlot?: (room: Room, minute: number) => void;
  onPreviewBooking?: (room: Room, booking: Booking) => void;
}

const AMENITY_ICON: Record<string, string> = {
  camera: "Cam",
  pc: "PC",
  cisco_vc: "Cisco",
  audio_conf: "Audio",
};

export function RoomRow({
  entry,
  dayStartHour,
  dayEndHour,
  timeZone,
  nowMinutes,
  slotMinutes,
  onSelectSlot,
  onPreviewBooking,
}: Props) {
  const { room } = entry;
  const longest = longestFreeMinutes(entry);
  const fullyFree = entry.busy.length === 0;

  return (
    <div className="grid grid-cols-[minmax(8rem,11rem)_1fr] gap-3 py-2 sm:gap-4">
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-semibold text-slate-800 dark:text-slate-100">
            {room.name}
          </span>
          {!room.online && (
            <span
              className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
              title="The appliance did not respond; availability may be stale"
            >
              offline
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">{room.capacity} seats</span>
          {room.floor !== null && <span>floor {room.floor}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {room.amenities.map((a) => (
            <span
              key={a}
              className="rounded bg-slate-100 px-1 py-px text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              title={AMENITY_LABELS[a]}
            >
              {AMENITY_ICON[a] ?? a}
            </span>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        <Timeline
          entry={entry}
          dayStartHour={dayStartHour}
          dayEndHour={dayEndHour}
          timeZone={timeZone}
          nowMinutes={nowMinutes}
          slotMinutes={slotMinutes}
          onSelectMinute={
            entry.room.online && onSelectSlot
              ? (minute) => onSelectSlot(entry.room, minute)
              : undefined
          }
          onPreviewBooking={
            onPreviewBooking ? (booking) => onPreviewBooking(entry.room, booking) : undefined
          }
        />
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
          {fullyFree ? (
            <span className="font-medium text-emerald-700 dark:text-emerald-400">
              Free all day
            </span>
          ) : (
            <>
              <span className="text-slate-500 dark:text-slate-400">
                longest gap{" "}
                <span className="font-medium text-slate-700 tabular-nums dark:text-slate-200">
                  {longest >= 60
                    ? `${Math.floor(longest / 60)}h${longest % 60 ? ` ${longest % 60}m` : ""}`
                    : `${longest}m`}
                </span>
              </span>
              <span className="truncate text-slate-400 dark:text-slate-500">
                {entry.free
                  .slice(0, 4)
                  .map(
                    (g) =>
                      `${formatTime(g.start, timeZone)}-${formatTime(g.end, timeZone)}`,
                  )
                  .join(", ")}
                {entry.free.length > 4 ? ` +${entry.free.length - 4} more` : ""}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Shown in place of a row when the appliance failed to answer. */
export function RoomErrorRow({ roomId, message }: { roomId: string; message: string }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,11rem)_1fr] gap-3 py-2 sm:gap-4">
      <div className="truncate font-semibold text-slate-400 dark:text-slate-500">
        {roomId}
      </div>
      <div
        className="flex h-11 items-center rounded-md bg-slate-100 px-3 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700"
        title={message}
      >
        {/* Not the same as "free": we genuinely do not know. */}
        Couldn't read this room's schedule
      </div>
    </div>
  );
}

export { formatDuration };
