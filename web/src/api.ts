/**
 * Client for the relay API.
 *
 * Types mirror `relay/src/rooms.ts` and `relay/src/availability.ts`. They are
 * duplicated rather than shared because the two halves deploy independently —
 * the UI to static hosting, the relay to a machine on the building's network —
 * and a shared package would couple their release cycles for four interfaces.
 */

export type Amenity = "camera" | "pc" | "cisco_vc" | "audio_conf";

export interface Room {
  id: string;
  name: string;
  host: string;
  capacity: number;
  floor: number | null;
  location: string;
  amenities: Amenity[];
  facilities: string;
  online: boolean;
  isPrivate: boolean;
}

export interface Fleet {
  site: string;
  rooms: Room[];
  dayStartHour: number;
  dayEndHour: number;
  slotMinutes: number;
  /** Longest single booking the relay accepts; the UI offers only end times within it. */
  maxBookingHours: number;
  timezone: string;
  applianceTime: string | null;
}

export interface Booking {
  id: string;
  roomId: string;
  /** ISO 8601 with an explicit offset. */
  start: string;
  end: string;
  /** Null when the booking is confidential. */
  purpose: string | null;
  host: string | null;
  /** Optional even when set — not every booking has one. Same visibility rule as purpose/host. */
  hostEmail: string | null;
  isConfidential: boolean;
  createdAt: string | null;
}

export interface Interval {
  start: string;
  end: string;
}

export interface RoomAvailability {
  room: Room;
  busy: Booking[];
  free: Interval[];
}

export interface AvailabilityResult {
  from: string;
  to: string;
  fleet: Omit<Fleet, "rooms">;
  rooms: RoomAvailability[];
  errors: { roomId: string; host: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Relay location
// ---------------------------------------------------------------------------

const STORAGE_KEY = "relayUrl";
const DEFAULT_RELAY_URL = "http://localhost:8787";

/**
 * The relay lives on the building's network, so its address differs per
 * deployment and can't be baked into a statically-hosted bundle. Build-time
 * default, overridable at runtime from the settings panel.
 */
export function getRelayUrl(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored.trim()) return stored.trim().replace(/\/+$/, "");

  // Truthiness, not `??`. CI passes VITE_RELAY_URL through from a repo variable
  // that is usually unset, which arrives as an empty string rather than
  // undefined — and `?? ` would happily accept "", making every request
  // relative to the page's own origin and 404 against GitHub Pages.
  const fromEnv = import.meta.env.VITE_RELAY_URL as string | undefined;
  const base = fromEnv && fromEnv.trim() ? fromEnv.trim() : DEFAULT_RELAY_URL;
  return base.replace(/\/+$/, "");
}

export function setRelayUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
  else localStorage.removeItem(STORAGE_KEY);
}

export class RelayError extends Error {
  readonly status: number;
  readonly isNetwork: boolean;

  constructor(message: string, status: number, isNetwork = false) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.isNetwork = isNetwork;
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${getRelayUrl()}${path}`, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // Distinguished from an HTTP error because the cause is almost always
    // "relay isn't running" or "you're off the building's network", and the UI
    // should say so rather than show a generic failure.
    throw new RelayError(
      `Can't reach the relay at ${getRelayUrl()}`,
      0,
      true,
    );
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      if (body.error) detail = body.detail ? `${body.error}: ${body.detail}` : body.error;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new RelayError(detail, res.status);
  }

  return (await res.json()) as T;
}

export const fetchFleet = (signal?: AbortSignal) => get<Fleet>("/api/rooms", signal);

export const fetchAvailability = (from: string, days: number, signal?: AbortSignal) =>
  get<AvailabilityResult>(
    `/api/availability?from=${encodeURIComponent(from)}&days=${days}`,
    signal,
  );

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  roomId: string;
  /** Naive local datetime, no offset — the relay resolves it in the fleet's own timezone. */
  start: string;
  end: string;
  purpose: string;
  hostFirstName: string;
  hostLastName: string;
  /** Optional. Visible to anyone who views this room's schedule — there's no login to hide it behind. */
  hostEmail?: string;
  /** Required to change or cancel later. Omit to let the relay generate one. */
  password?: string;
  /**
   * Ties the booking to this browser's chat thread so the assistant can list,
   * reschedule and cancel it without the browser's local copy. Sent for every
   * booking, however it was made, so the chat and the My bookings panel see
   * the same set.
   */
  ownerKey?: string;
}

export interface CreatedBooking {
  id: string;
  roomId: string;
  start: string;
  end: string;
  purpose: string;
  /**
   * Returned exactly once, on creation. The relay is stateless and does not
   * keep it — this is the only chance to capture it for a later cancellation,
   * which is why createBooking persists it to local storage immediately.
   */
  password: string;
}

async function send<T>(method: "POST" | "PUT" | "DELETE", path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${getRelayUrl()}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RelayError(`Can't reach the relay at ${getRelayUrl()}`, 0, true);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await res.json();
  } catch {
    // A non-JSON body on failure just means we fall through to the status line.
  }

  if (!res.ok) {
    const error = typeof payload.error === "string" ? payload.error : `HTTP ${res.status}`;
    throw new RelayError(error, res.status);
  }
  return payload as T;
}

export const createBooking = (input: CreateBookingInput) =>
  send<CreatedBooking>("POST", "/api/book", input);

export interface UpdateBookingInput extends CreateBookingInput {
  /** The booking's current password, proving the caller may edit it. */
  currentPassword: string;
}

export const updateBooking = (roomId: string, bookingId: string, input: UpdateBookingInput) =>
  send<{ ok: true }>(
    "PUT",
    `/api/booking/${encodeURIComponent(roomId)}/${encodeURIComponent(bookingId)}`,
    input,
  );

export const cancelBooking = (
  roomId: string,
  bookingId: string,
  password: string,
  ownerKey?: string,
) =>
  send<{ ok: true }>("DELETE", `/api/booking/${encodeURIComponent(roomId)}/${encodeURIComponent(bookingId)}`, {
    password,
    ...(ownerKey ? { ownerKey } : {}),
  });

/**
 * This browser's stable chat-thread id, which doubles as the key tying its
 * bookings to that thread. One per browser, so the assistant's idea of "your
 * bookings" matches the My bookings panel's.
 */
export function ownerKey(): string {
  let id = localStorage.getItem("conversationId");
  if (!id) {
    id = `c_${crypto.randomUUID()}`;
    localStorage.setItem("conversationId", id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Slot finding
// ---------------------------------------------------------------------------

export interface SlotCandidate {
  roomId: string;
  roomName: string;
  capacity: number;
  floor: number | null;
  amenities: Amenity[];
  start: string;
  end: string;
  /** 0..1, higher is better. */
  score: number;
  /** Human-readable justifications, safe to show verbatim. */
  reasons: string[];
}

export interface FindSlotsResult {
  candidates: SlotCandidate[];
  totalFound: number;
  /** Set when nothing matched, naming the binding constraint. */
  noMatchReason: string | null;
}

export interface SlotSearch {
  duration: number;
  days: number;
  minCapacity?: number;
  amenities: Amenity[];
  earliestHour?: number;
  latestHour?: number;
}

export function findSlots(search: SlotSearch, signal?: AbortSignal) {
  const p = new URLSearchParams({
    duration: String(search.duration),
    days: String(search.days),
  });
  if (search.minCapacity) p.set("minCapacity", String(search.minCapacity));
  if (search.amenities.length > 0) p.set("amenities", search.amenities.join(","));
  if (search.earliestHour !== undefined) p.set("earliestHour", String(search.earliestHour));
  if (search.latestHour !== undefined) p.set("latestHour", String(search.latestHour));
  return get<FindSlotsResult>(`/api/slots?${p.toString()}`, signal);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface AgentProposal {
  roomId: string;
  roomName: string;
  start: string;
  end: string;
  purpose: string;
}

export interface SlotHighlight {
  roomId: string;
  start: string;
  end: string;
  label?: string;
}

/** How the chat wants the calendar view to change. Derived from tool calls. */
export interface UiDirective {
  date?: string;
  filters?: {
    minCapacity?: number;
    amenities?: Amenity[];
    minFreeMinutes?: number;
  };
  highlights?: SlotHighlight[];
  focusRoomId?: string;
}

export interface AgentTurn {
  reply: string;
  /** Rendered as confirmation cards. Nothing is booked until the user clicks. */
  proposals: AgentProposal[];
  toolsUsed: string[];
  /** Null when the turn didn't look at anything view-worthy. */
  uiDirective: UiDirective | null;
}

export interface ChatContext {
  selectedDate?: string;
  roomId?: string;
  startTime?: string;
  endTime?: string;
}

export const chatHealth = (signal?: AbortSignal) =>
  get<{ ok: boolean; model: string; detail: string }>("/api/chat/health", signal);

export const sendChat = (conversationId: string, message: string, ctx: ChatContext) =>
  send<AgentTurn>("POST", "/api/chat", { conversationId, message, ...ctx });

export type TurnEvent =
  | { type: "token"; text: string }
  | { type: "discard" }
  | { type: "tool"; name: string }
  | { type: "done"; turn: AgentTurn }
  | { type: "error"; message: string };

/**
 * Streaming chat turn over SSE.
 *
 * Uses `fetch` with a manual parser rather than `EventSource`, because this
 * is a POST with a JSON body and `EventSource` only does GET.
 */
export async function streamChat(
  conversationId: string,
  message: string,
  ctx: ChatContext,
  onEvent: (e: TurnEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${getRelayUrl()}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, message, ...ctx }),
      signal,
    });
  } catch {
    throw new RelayError(`Can't reach the relay at ${getRelayUrl()}`, 0, true);
  }
  if (!res.ok || !res.body) {
    throw new RelayError(`Chat failed (HTTP ${res.status})`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; keep any trailing partial.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as TurnEvent);
        } catch {
          // A malformed frame is not worth tearing the stream down over.
        }
      }
    }
  }
}

export const loadTranscript = (conversationId: string, signal?: AbortSignal) =>
  get<{ messages: { role: string; content: string; at: string }[] }>(
    `/api/chat/${encodeURIComponent(conversationId)}`,
    signal,
  );

export interface UnlockedBooking {
  purpose: string;
  hostFirstName: string;
  hostLastName: string;
  hostEmail: string;
  start: string;
  end: string;
}

/**
 * Prove a booking's password and get back its real current fields. The
 * appliance keeps these hidden from anyone who hasn't supplied the password,
 * even on its own edit page — this is the only way to get an accurate
 * starting point for editing, for a booking this browser already recognizes
 * as its own just as much as one it doesn't.
 */
export const unlockBooking = (roomId: string, bookingId: string, password: string) =>
  send<UnlockedBooking>(
    "POST",
    `/api/booking/${encodeURIComponent(roomId)}/${encodeURIComponent(bookingId)}/unlock`,
    { password },
  );
