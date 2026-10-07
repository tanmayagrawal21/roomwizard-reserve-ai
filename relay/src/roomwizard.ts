/**
 * Low-level client for the RoomWizard appliances.
 *
 * Two endpoints are used here, both verified live:
 *
 *   GET {rosterHost}/getGroupTimeLineJSON.action?date=YYYYMMDD
 *       The room roster. Any appliance aggregates all the others as "buddies",
 *       so one call describes the whole fleet.
 *
 *   GET {roomHost}/Connector?command=get_bookings&format=json&range_...
 *       Bookings for one room over a time range.
 *
 * Deliberately not used: Connector's `delete_booking` (recognized, but returns
 * result_code 1 for every parameter shape tried) and `GroupViewProxyServlet`
 * (an open proxy on the appliance itself — works, but adds a hop and no CORS).
 */

import { request } from "undici";
import { APPLIANCE_TIMEOUT_MS } from "./config.ts";
import { applianceAgent, assertApplianceUrl } from "./tls.ts";
import { toApplianceDate, toApplianceTime, type Instant } from "./time.ts";

/** One room as the roster describes it. */
export interface RawBuddy {
  roomName: string;
  host: string;
  capacity: number;
  location: string;
  facilities: string;
  success: boolean;
  isPrivateRoom: boolean;
  isAlwaysInUse: boolean;
}

export interface RawRoster {
  currentTime: string;
  timelineStart: string;
  timelineEnd: string;
  timeFormat: string;
  timezoneOffset: number;
  defaultBookingLength: number;
  buddyList: RawBuddy[];
  groups: { name: string; url: string; selected: boolean }[];
}

/** One booking as the Connector describes it. */
export interface RawBooking {
  Id: string;
  start: string;
  end: string;
  purpose: string;
  notes: string;
  hostFirstName: string;
  hostLastName: string;
  hostEmail: string;
  isConfidential: boolean;
  hideMeetingDetails: boolean;
  isPasswordProtected: boolean;
  /**
   * Credential material for editing or removing the booking. The appliance
   * includes this in its responses; the relay strips it before anything
   * reaches a client. Never include it in a response. See PLAN.md §7.
   */
  password?: string;
  creationDate: string;
  modificationDate: string;
  Attendees?: { role: string; name: string; email: string; phone: string; status: string }[];
}

export class ApplianceError extends Error {
  readonly host: string;

  constructor(message: string, host: string, cause?: unknown) {
    // Use the standard Error `cause` rather than shadowing it.
    super(message, { cause });
    this.name = "ApplianceError";
    this.host = host;
  }
}

/** A single GET against an appliance, with the permissive-TLS agent. */
async function applianceGet(url: URL, host: string): Promise<string> {
  assertApplianceUrl(url);
  const signal = AbortSignal.timeout(APPLIANCE_TIMEOUT_MS);
  try {
    const res = await request(url, {
      method: "GET",
      dispatcher: applianceAgent,
      signal,
      headers: { accept: "application/json, text/plain, */*" },
    });
    const body = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new ApplianceError(
        `${url.pathname} returned HTTP ${res.statusCode}`,
        host,
      );
    }
    return body;
  } catch (err) {
    if (err instanceof ApplianceError) throw err;
    throw new ApplianceError(`Request to ${url.href} failed`, host, err);
  }
}

/**
 * The appliances occasionally serve an HTML error page with a 200 status, so a
 * parse failure is a normal outcome rather than an exception to let escape.
 */
function parseJson<T>(body: string, url: URL, host: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    const preview = body.slice(0, 120).replace(/\s+/g, " ");
    throw new ApplianceError(
      `${url.pathname} returned non-JSON (${body.length} bytes): ${preview}`,
      host,
    );
  }
}

/** Fetch the room roster from any one appliance. */
export async function fetchRoster(rosterHost: string, on: Instant): Promise<RawRoster> {
  const url = new URL("getGroupTimeLineJSON.action", rosterHost);
  url.searchParams.set("date", toApplianceDate(on));
  const body = await applianceGet(url, rosterHost);
  const roster = parseJson<RawRoster>(body, url, rosterHost);
  if (!Array.isArray(roster.buddyList)) {
    throw new ApplianceError("Roster response had no buddyList", rosterHost);
  }
  return roster;
}

/**
 * Fetch bookings for one room over `[from, to)`.
 *
 * The range is expressed as four separate params because that is what the
 * Connector accepts. A range ending at midnight must be expressed as the next
 * day at `000000`, which `toApplianceDate`/`toApplianceTime` handle naturally
 * since we pass real instants.
 */
export async function fetchBookings(
  roomHost: string,
  from: Instant,
  to: Instant,
): Promise<RawBooking[]> {
  const url = new URL("Connector", roomHost);
  url.searchParams.set("command", "get_bookings");
  url.searchParams.set("format", "json");
  url.searchParams.set("range_start_date", toApplianceDate(from));
  url.searchParams.set("range_start_time", toApplianceTime(from));
  url.searchParams.set("range_end_date", toApplianceDate(to));
  url.searchParams.set("range_end_time", toApplianceTime(to));

  const body = await applianceGet(url, roomHost);
  const parsed = parseJson<RawBooking[]>(body, url, roomHost);
  if (!Array.isArray(parsed)) {
    throw new ApplianceError("get_bookings did not return an array", roomHost);
  }
  return parsed;
}
