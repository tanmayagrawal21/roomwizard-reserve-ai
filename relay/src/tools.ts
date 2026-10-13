/**
 * Tools the chat model may call.
 *
 * Shaped around one constraint (PLAN.md section 5): a 4B model is unreliable
 * at multi-constraint search and at nested arguments. So:
 *
 *   - Every parameter is a flat scalar. No objects, no arrays of objects.
 *   - Enums wherever a free string would invite invention.
 *   - Dates are plain `YYYY-MM-DD`, and the system prompt pre-resolves
 *     "tomorrow" so the model never does calendar arithmetic.
 *   - Searching and ranking happen in `slots.ts`, not in the prompt. The
 *     model picks among pre-scored candidates.
 *
 * Writes are the important asymmetry: `propose_booking` does not book
 * anything. It returns a confirmation card for the human to click, because a
 * small model should not be able to claim a shared room on its own
 * interpretation of an ambiguous sentence.
 */

import { z } from "zod";
import { MAX_BOOKING_HOURS } from "./config.ts";
import { getAvailability } from "./availability.ts";
import { findRoom, getFleet } from "./rooms.ts";
import { findSlots } from "./slots.ts";
import { cancelBooking, updateBooking } from "./booking.ts";
import {
  findOwnedBooking,
  forgetBooking,
  listOwnedBookings,
  updateOwnedBooking,
} from "./bookingStore.ts";
import {
  addDays,
  localParts,
  parseClientDateTime,
  startOfLocalDay,
  toIso,
  toIsoDate,
} from "./time.ts";
import type { ToolDef } from "./llm.ts";

const AMENITY_ENUM = ["camera", "pc", "cisco_vc", "audio_conf"] as const;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_rooms",
    description:
      "List every room with its capacity, floor, and equipment. Use this to answer questions about what rooms exist or what they have, not to check availability.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_slots",
    description:
      "Find and rank available time slots for a meeting. This is the main tool: use it whenever someone asks where/when they could meet. It handles all the searching and ranking.",
    parameters: {
      type: "object",
      properties: {
        duration_minutes: {
          type: "integer",
          description: "How long the meeting is, in minutes. Default 60 if unstated.",
        },
        date: {
          type: "string",
          description:
            "First day to search, as YYYY-MM-DD. Defaults to today. Use the resolved dates given in the system message; never guess.",
        },
        days: {
          type: "integer",
          description: "How many days from `date` to search. Use 1 for a specific day, 7 for 'this week'.",
        },
        min_capacity: {
          type: "integer",
          description: "Minimum number of seats needed. Omit if headcount was not mentioned.",
        },
        needs: {
          type: "string",
          enum: [...AMENITY_ENUM],
          description:
            "A single required piece of equipment. camera = video conferencing camera, pc = in-room computer, cisco_vc = Cisco video system, audio_conf = audio conferencing.",
        },
        earliest_hour: {
          type: "integer",
          description: "Earliest acceptable start, 24-hour clock. Morning = 7, afternoon = 12.",
        },
        latest_hour: {
          type: "integer",
          description: "Latest acceptable end, 24-hour clock. Morning = 12, afternoon = 17.",
        },
      },
      required: ["duration_minutes"],
    },
  },
  {
    name: "check_room",
    description:
      "Show one specific room's bookings and free gaps for one day. Use when someone asks about a named room, e.g. 'is BSRL-258 free tomorrow?'.",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "Room id, lowercase, e.g. bsrl-258." },
        date: { type: "string", description: "Day to check, YYYY-MM-DD." },
      },
      required: ["room_id", "date"],
    },
  },
  {
    name: "list_my_bookings",
    description:
      "List the bookings this user has made through this assistant, with their ids. Use before cancelling or rescheduling so you have the right id, and whenever they ask what they have booked.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_my_booking",
    description:
      "Cancel one of the user's own bookings. Call list_my_bookings first to get the id. Confirm with the user which booking they mean before calling this — it cannot be undone.",
    parameters: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "Id from list_my_bookings." },
        room_id: { type: "string", description: "Room id from list_my_bookings, e.g. bsrl-203." },
      },
      required: ["booking_id", "room_id"],
    },
  },
  {
    name: "reschedule_my_booking",
    description:
      "Change the time and/or subject of one of the user's own bookings. Call list_my_bookings first to get the id.",
    parameters: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "Id from list_my_bookings." },
        room_id: { type: "string", description: "Room id from list_my_bookings." },
        date: { type: "string", description: "New day, YYYY-MM-DD." },
        start_time: { type: "string", description: "New start, 24-hour HH:MM." },
        end_time: { type: "string", description: "New end, 24-hour HH:MM." },
        purpose: { type: "string", description: "New subject. Omit to keep the current one." },
      },
      required: ["booking_id", "room_id", "date", "start_time", "end_time"],
    },
  },
  {
    name: "show_calendar",
    description:
      "Move the user's calendar view to a particular day, and optionally focus one room. Use for pure navigation requests like 'show me Thursday' where no search is needed.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Day to show, YYYY-MM-DD." },
        room_id: { type: "string", description: "Optional room to focus, lowercase, e.g. bsrl-258." },
      },
      required: ["date"],
    },
  },
  {
    name: "propose_booking",
    description:
      "Propose a booking for the user to confirm. This does NOT book anything — it shows the user a confirmation card they must click. Always call this rather than claiming you have booked something. Confirm the room, time, and purpose are what the user asked for before calling.",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "Room id, lowercase, e.g. bsrl-258." },
        date: { type: "string", description: "Day of the booking, YYYY-MM-DD." },
        start_time: { type: "string", description: "Start, 24-hour HH:MM, e.g. 14:00." },
        end_time: { type: "string", description: "End, 24-hour HH:MM, e.g. 15:30." },
        purpose: {
          type: "string",
          description: "Short meeting subject, max 50 chars. Ask the user if they have not said.",
        },
      },
      required: ["room_id", "date", "start_time", "end_time", "purpose"],
    },
  },
];

/**
 * Instructions for the front-end to reflect what the model just looked at:
 * jump to a day, apply the filters implied by the question, highlight the
 * candidate slots it found.
 *
 * These are *derived from tool calls*, not requested by the model. Asking a 4B
 * model to additionally remember to call an "update the view" tool is exactly
 * the kind of discipline it does not reliably have — whereas the fact that it
 * searched Thursday for camera rooms seating six is already unambiguous in the
 * arguments it passed. Driving the UI off that is reliable for free.
 */
export interface UiDirective {
  /** Navigate the calendar to this day, `YYYY-MM-DD`. */
  date?: string;
  /** Filters to apply, mirroring the question's constraints. */
  filters?: {
    minCapacity?: number;
    amenities?: string[];
    minFreeMinutes?: number;
  };
  /** Specific openings to call out on the timeline. */
  highlights?: { roomId: string; start: string; end: string; label?: string }[];
  /** Scroll to / emphasise one room. */
  focusRoomId?: string;
}

/** A tool's result, plus anything the UI should render specially. */
export interface ToolResult {
  /** JSON text handed back to the model. Kept small — context is precious. */
  content: string;
  /**
   * Set by `propose_booking`. The relay never acts on this; the front-end
   * renders it as a card and the human's click is what calls `POST /api/book`.
   */
  proposal?: {
    roomId: string;
    roomName: string;
    start: string;
    end: string;
    purpose: string;
  };
  /** How the UI should update to show what this tool looked at. */
  uiDirective?: UiDirective;
}

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const timeArg = z.string().regex(/^\d{1,2}:\d{2}$/, "time must be HH:MM");

const findSlotsArgs = z.object({
  duration_minutes: z.coerce.number().int().min(5).max(MAX_BOOKING_HOURS * 60),
  date: dateArg.optional(),
  days: z.coerce.number().int().min(1).max(31).optional(),
  min_capacity: z.coerce.number().int().min(1).max(500).optional(),
  needs: z.enum(AMENITY_ENUM).optional(),
  earliest_hour: z.coerce.number().min(0).max(24).optional(),
  latest_hour: z.coerce.number().min(0).max(24).optional(),
});

const checkRoomArgs = z.object({ room_id: z.string().min(1), date: dateArg });

const proposeArgs = z.object({
  room_id: z.string().min(1),
  date: dateArg,
  start_time: timeArg,
  end_time: timeArg,
  purpose: z.string().trim().min(1).max(50),
});

/**
 * Run a tool call. Never throws for model mistakes: a bad argument comes back
 * as an error *string* so the model can see what it got wrong and retry, which
 * is far more recoverable than a 500 ending the turn.
 */
export async function runTool(
  name: string,
  argumentsJson: string,
  /**
   * Whose bookings the my-* tools act on. A bearer key, not an account: see
   * `bookingStore.ts`. Absent means those tools are unavailable this turn.
   */
  ownerKey?: string,
): Promise<ToolResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(argumentsJson || "{}");
  } catch {
    return { content: `Error: arguments were not valid JSON. Received: ${argumentsJson.slice(0, 120)}` };
  }

  try {
    switch (name) {
      case "list_rooms":
        return await toolListRooms();
      case "find_slots":
        return await toolFindSlots(raw);
      case "check_room":
        return await toolCheckRoom(raw);
      case "show_calendar":
        return await toolShowCalendar(raw);
      case "propose_booking":
        return await toolProposeBooking(raw);
      case "list_my_bookings":
        return await toolListMyBookings(ownerKey);
      case "cancel_my_booking":
        return await toolCancelMyBooking(raw, ownerKey);
      case "reschedule_my_booking":
        return await toolRescheduleMyBooking(raw, ownerKey);
      default:
        return { content: `Error: no such tool "${name}".` };
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function toolListRooms(): Promise<ToolResult> {
  const fleet = await getFleet(new Date());
  return {
    content: JSON.stringify({
      bookable_hours: `${fleet.dayStartHour}:00-${fleet.dayEndHour}:00`,
      rooms: fleet.rooms.map((r) => ({
        id: r.id,
        seats: r.capacity,
        floor: r.floor,
        has: r.amenities,
        online: r.online,
      })),
    }),
  };
}

async function toolFindSlots(raw: unknown): Promise<ToolResult> {
  const parsed = findSlotsArgs.safeParse(raw);
  if (!parsed.success) {
    return { content: `Error: ${flatten(parsed.error)}` };
  }
  const a = parsed.data;

  const from = a.date ? startOfLocalDay(parseClientDateTime(a.date)) : startOfLocalDay(new Date());
  const to = addDays(from, a.days ?? 7);

  const result = await findSlots({
    from,
    to,
    durationMinutes: a.duration_minutes,
    ...(a.min_capacity !== undefined ? { minCapacity: a.min_capacity } : {}),
    amenities: a.needs ? [a.needs] : [],
    ...(a.earliest_hour !== undefined ? { earliestHour: a.earliest_hour } : {}),
    ...(a.latest_hour !== undefined ? { latestHour: a.latest_hour } : {}),
    limit: 5,
  });

  // Reflect the search in the UI even when it found nothing: showing the day
  // and filters makes an empty result legible instead of mysterious.
  const directive: UiDirective = {
    date: toIsoDate(from),
    filters: {
      ...(a.min_capacity !== undefined ? { minCapacity: a.min_capacity } : {}),
      ...(a.needs ? { amenities: [a.needs] } : {}),
      minFreeMinutes: a.duration_minutes,
    },
  };

  if (result.candidates.length === 0) {
    return {
      content: JSON.stringify({ found: 0, why: result.noMatchReason }),
      uiDirective: directive,
    };
  }
  // Compact on purpose: a small model reading five tidy rows behaves much
  // better than one reading five verbose objects.
  return {
    content: JSON.stringify({
      found: result.totalFound,
      options: result.candidates.map((c) => ({
        room_id: c.roomId,
        room: c.roomName,
        date: c.start.slice(0, 10),
        start: c.start.slice(11, 16),
        end: c.end.slice(11, 16),
        seats: c.capacity,
        why: c.reasons.join("; ") || undefined,
      })),
    }),
    uiDirective: {
      ...directive,
      // Jump to the day the best suggestion is actually on, which may not be
      // the first day of the searched range.
      date: result.candidates[0]!.start.slice(0, 10),
      highlights: result.candidates.map((c) => ({
        roomId: c.roomId,
        start: c.start,
        end: c.end,
        label: c.reasons[0],
      })),
    },
  };
}

async function toolCheckRoom(raw: unknown): Promise<ToolResult> {
  const parsed = checkRoomArgs.safeParse(raw);
  if (!parsed.success) return { content: `Error: ${flatten(parsed.error)}` };
  const { room_id, date } = parsed.data;

  const from = startOfLocalDay(parseClientDateTime(date));
  const to = addDays(from, 1);
  const fleet = await getFleet(from);
  const room = findRoom(fleet, room_id.toLowerCase());
  if (!room) {
    return {
      content: `Error: no room "${room_id}". Valid ids: ${fleet.rooms.map((r) => r.id).join(", ")}`,
    };
  }

  const availability = await getAvailability(from, to);
  const entry = availability.rooms.find((r) => r.room.id === room.id);
  if (!entry) {
    return { content: JSON.stringify({ room: room.name, date, error: "could not read its schedule" }) };
  }

  return {
    content: JSON.stringify({
      room: room.name,
      date,
      seats: room.capacity,
      booked: entry.busy.map((b) => ({
        start: b.start.slice(11, 16),
        end: b.end.slice(11, 16),
        what: b.isConfidential ? "private" : b.purpose,
      })),
      free: entry.free.map((f) => ({ start: f.start.slice(11, 16), end: f.end.slice(11, 16) })),
    }),
    uiDirective: {
      date,
      focusRoomId: room.id,
      highlights: entry.free.map((f) => ({ roomId: room.id, start: f.start, end: f.end })),
    },
  };
}

const showCalendarArgs = z.object({ date: dateArg, room_id: z.string().optional() });

async function toolShowCalendar(raw: unknown): Promise<ToolResult> {
  const parsed = showCalendarArgs.safeParse(raw);
  if (!parsed.success) return { content: `Error: ${flatten(parsed.error)}` };
  const { date, room_id } = parsed.data;

  const fleet = await getFleet(parseClientDateTime(date));
  let focusRoomId: string | undefined;
  if (room_id) {
    const room = findRoom(fleet, room_id.toLowerCase());
    if (!room) {
      return {
        content: `Error: no room "${room_id}". Valid ids: ${fleet.rooms.map((r) => r.id).join(", ")}`,
      };
    }
    focusRoomId = room.id;
  }

  return {
    content: JSON.stringify({ showing: date, room: focusRoomId ?? "all" }),
    uiDirective: { date, ...(focusRoomId ? { focusRoomId } : {}) },
  };
}

/**
 * Validates and echoes back a proposal. Explicitly does not write: the
 * returned `proposal` becomes a card the human clicks (PLAN.md section 5).
 */
async function toolProposeBooking(raw: unknown): Promise<ToolResult> {
  const parsed = proposeArgs.safeParse(raw);
  if (!parsed.success) return { content: `Error: ${flatten(parsed.error)}` };
  const a = parsed.data;

  const fleet = await getFleet(new Date());
  const room = findRoom(fleet, a.room_id.toLowerCase());
  if (!room) {
    return {
      content: `Error: no room "${a.room_id}". Valid ids: ${fleet.rooms.map((r) => r.id).join(", ")}`,
    };
  }

  const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
  const start = parseClientDateTime(`${a.date}T${pad(a.start_time)}:00`);
  const end = parseClientDateTime(`${a.date}T${pad(a.end_time)}:00`);
  if (end.getTime() <= start.getTime()) {
    return { content: "Error: end_time must be after start_time." };
  }

  const sp = localParts(start);
  const ep = localParts(end);
  const startMin = sp.hour * 60 + sp.minute;
  const endMin = ep.hour === 0 && ep.minute === 0 ? fleet.dayEndHour * 60 : ep.hour * 60 + ep.minute;
  if (startMin < fleet.dayStartHour * 60 || endMin > fleet.dayEndHour * 60) {
    return {
      content: `Error: rooms are only bookable ${fleet.dayStartHour}:00-${fleet.dayEndHour}:00.`,
    };
  }

  // Check it is actually free, so the model does not propose something the
  // user will click and then be told is taken.
  const availability = await getAvailability(start, end);
  const entry = availability.rooms.find((r) => r.room.id === room.id);
  const clash = entry?.busy.find(
    (b) => parseClientDateTime(b.end) > start && parseClientDateTime(b.start) < end,
  );
  if (clash) {
    return {
      content: JSON.stringify({
        error: "that time is already booked",
        conflict: { start: clash.start.slice(11, 16), end: clash.end.slice(11, 16) },
      }),
    };
  }

  return {
    content: JSON.stringify({
      proposed: true,
      note: "Shown to the user as a confirmation card. Tell them to confirm it; do not claim it is booked.",
      room: room.name,
      date: toIsoDate(start),
      start: a.start_time,
      end: a.end_time,
    }),
    proposal: {
      roomId: room.id,
      roomName: room.name,
      start: toIso(start),
      end: toIso(end),
      purpose: a.purpose,
    },
    uiDirective: {
      date: toIsoDate(start),
      focusRoomId: room.id,
      highlights: [{ roomId: room.id, start: toIso(start), end: toIso(end), label: "proposed" }],
    },
  };
}

function flatten(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "argument"}: ${i.message}`).join("; ");
}


// ---------------------------------------------------------------------------
// The user's own bookings
// ---------------------------------------------------------------------------

const NO_OWNER =
  "Error: this conversation has no booking identity, so I can't see or change bookings. The user should book something first.";

const cancelMineArgs = z.object({ booking_id: z.string().min(1), room_id: z.string().min(1) });
const rescheduleMineArgs = z.object({
  booking_id: z.string().min(1),
  room_id: z.string().min(1),
  date: dateArg,
  start_time: timeArg,
  end_time: timeArg,
  purpose: z.string().trim().max(50).optional(),
});

async function toolListMyBookings(ownerKey?: string): Promise<ToolResult> {
  if (!ownerKey) return { content: NO_OWNER };
  const mine = listOwnedBookings(ownerKey, new Date().toISOString());
  if (mine.length === 0) {
    return { content: JSON.stringify({ bookings: [], note: "nothing upcoming" }) };
  }
  return {
    content: JSON.stringify({
      // Ids are needed for cancel/reschedule; passwords deliberately are not
      // included — the relay looks those up itself when acting.
      bookings: mine.map((b) => ({
        booking_id: b.bookingId,
        room_id: b.roomId,
        room: b.roomName,
        date: b.start.slice(0, 10),
        start: b.start.slice(11, 16),
        end: b.end.slice(11, 16),
        purpose: b.purpose,
      })),
    }),
    uiDirective: {
      highlights: mine.map((b) => ({
        roomId: b.roomId,
        start: b.start,
        end: b.end,
        label: "yours",
      })),
    },
  };
}

async function toolCancelMyBooking(raw: unknown, ownerKey?: string): Promise<ToolResult> {
  if (!ownerKey) return { content: NO_OWNER };
  const parsed = cancelMineArgs.safeParse(raw);
  if (!parsed.success) return { content: `Error: ${flatten(parsed.error)}` };
  const { booking_id, room_id } = parsed.data;

  const owned = findOwnedBooking(ownerKey, room_id.toLowerCase(), booking_id);
  if (!owned) {
    return {
      content: `Error: no booking ${booking_id} in ${room_id} belongs to this user. Call list_my_bookings for the real ids.`,
    };
  }

  const fleet = await getFleet(new Date());
  const room = findRoom(fleet, owned.roomId);
  if (!room) return { content: `Error: room ${owned.roomId} is not in the fleet any more.` };

  await cancelBooking({ room, bookingId: owned.bookingId, password: owned.password });
  forgetBooking(ownerKey, owned.roomId, owned.bookingId);

  return {
    content: JSON.stringify({
      cancelled: true,
      room: owned.roomName,
      date: owned.start.slice(0, 10),
      start: owned.start.slice(11, 16),
    }),
    uiDirective: { date: owned.start.slice(0, 10), focusRoomId: owned.roomId },
  };
}

async function toolRescheduleMyBooking(raw: unknown, ownerKey?: string): Promise<ToolResult> {
  if (!ownerKey) return { content: NO_OWNER };
  const parsed = rescheduleMineArgs.safeParse(raw);
  if (!parsed.success) return { content: `Error: ${flatten(parsed.error)}` };
  const a = parsed.data;

  const owned = findOwnedBooking(ownerKey, a.room_id.toLowerCase(), a.booking_id);
  if (!owned) {
    return {
      content: `Error: no booking ${a.booking_id} in ${a.room_id} belongs to this user. Call list_my_bookings for the real ids.`,
    };
  }

  const fleet = await getFleet(new Date());
  const room = findRoom(fleet, owned.roomId);
  if (!room) return { content: `Error: room ${owned.roomId} is not in the fleet any more.` };

  const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
  const start = parseClientDateTime(`${a.date}T${pad(a.start_time)}:00`);
  const end = parseClientDateTime(`${a.date}T${pad(a.end_time)}:00`);
  if (end.getTime() <= start.getTime()) {
    return { content: "Error: end_time must be after start_time." };
  }

  const sp = localParts(start);
  const ep = localParts(end);
  const startMin = sp.hour * 60 + sp.minute;
  const endMin = ep.hour === 0 && ep.minute === 0 ? fleet.dayEndHour * 60 : ep.hour * 60 + ep.minute;
  if (startMin < fleet.dayStartHour * 60 || endMin > fleet.dayEndHour * 60) {
    return {
      content: `Error: rooms are only bookable ${fleet.dayStartHour}:00-${fleet.dayEndHour}:00.`,
    };
  }

  // Clash check excluding the booking being moved, or it collides with itself.
  const availability = await getAvailability(start, end);
  const entry = availability.rooms.find((r) => r.room.id === room.id);
  const clash = entry?.busy.find(
    (b) =>
      b.id !== owned.bookingId &&
      parseClientDateTime(b.end) > start &&
      parseClientDateTime(b.start) < end,
  );
  if (clash) {
    return {
      content: JSON.stringify({
        error: "that new time is already booked",
        conflict: { start: clash.start.slice(11, 16), end: clash.end.slice(11, 16) },
      }),
    };
  }

  const purpose = a.purpose ?? owned.purpose;

  await updateBooking({
    room,
    bookingId: owned.bookingId,
    currentPassword: owned.password,
    start,
    end,
    purpose,
    // The appliance requires a host name on every write. We do not store one,
    // so reuse the purpose-independent placeholder the booking already has
    // rather than silently blanking it.
    hostFirstName: "Booked",
    hostLastName: "via assistant",
  });

  updateOwnedBooking(ownerKey, owned.roomId, owned.bookingId, {
    start: toIso(start),
    end: toIso(end),
    purpose,
  });

  return {
    content: JSON.stringify({
      rescheduled: true,
      room: owned.roomName,
      date: a.date,
      start: a.start_time,
      end: a.end_time,
      purpose,
    }),
    uiDirective: {
      date: a.date,
      focusRoomId: owned.roomId,
      highlights: [{ roomId: owned.roomId, start: toIso(start), end: toIso(end), label: "moved" }],
    },
  };
}
