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

export const cancelBooking = (roomId: string, bookingId: string, password: string) =>
  send<{ ok: true }>("DELETE", `/api/booking/${encodeURIComponent(roomId)}/${encodeURIComponent(bookingId)}`, {
    password,
  });

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
