/**
 * Relay configuration.
 *
 * Everything site-specific is an environment variable. The defaults describe
 * the BSRL building at the University of Arizona, which is the deployment this
 * has actually been tested against — but nothing in the code assumes it.
 *
 * To point the relay at a different RoomWizard installation you need, at
 * minimum, `RW_ROSTER_HOST` and `RW_TIMEZONE`. See `example.env`.
 *
 * Legacy `BSRL_*` names are still honoured so existing deployments keep
 * working; `RW_*` wins if both are set.
 */

/** Read an env var under its `RW_` name, falling back to the old `BSRL_` name. */
function env(name: string): string | undefined {
  return process.env[`RW_${name}`] ?? process.env[`BSRL_${name}`];
}

function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`RW_${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function envList(name: string, fallback: readonly string[]): readonly string[] {
  const raw = env(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

/** Ensure a host is an absolute URL with a trailing slash, for `new URL(path, host)`. */
function normalizeHost(host: string): string {
  const withScheme = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

/** Human-readable label for the installation, used in logs and the API. */
export const SITE_NAME = env("SITE_NAME") ?? "BSRL";

/**
 * IANA timezone the appliances are installed in. The appliances report wall
 * clock times with no offset, so this is required to interpret them.
 *
 * America/Phoenix does not observe DST, which is why the original version of
 * this code could get away with a fixed offset. Anywhere else, it cannot.
 */
export const TIMEZONE = env("TIMEZONE") ?? "America/Phoenix";

/**
 * The appliance we ask for the room roster. Any room in the group will do:
 * each one aggregates all the others as "buddies", so the list is identical
 * whichever we pick.
 */
export const ROSTER_HOST = normalizeHost(env("ROSTER_HOST") ?? "https://bsrl-203.arizona.edu/");

/**
 * Optional explicit room list, used only if the roster call fails. Normally
 * the roster is authoritative — it carries capacity and facilities too.
 */
export const ROOM_HOSTS: readonly string[] = envList("ROOM_HOSTS", []).map(normalizeHost);

/**
 * Hostname suffix the permissive TLS agent may be used for. Scoping this
 * matters: the appliances need a lowered OpenSSL security level, and we must
 * not weaken TLS for any other destination. Defaults to the roster host's
 * registrable-ish parent so a fresh deployment is safe without extra config.
 */
export const APPLIANCE_HOST_SUFFIX =
  env("HOST_SUFFIX") ?? defaultSuffixFrom(ROSTER_HOST);

function defaultSuffixFrom(host: string): string {
  const { hostname } = new URL(host);
  const labels = hostname.split(".");
  // `bsrl-203.arizona.edu` -> `.arizona.edu`
  return labels.length > 2 ? `.${labels.slice(1).join(".")}` : hostname;
}

// ---------------------------------------------------------------------------
// Booking window
// ---------------------------------------------------------------------------

/**
 * Fallback bookable window, local wall-clock hours. The roster normally
 * reports the real values (`timelineStart` / `timelineEnd`) and those win;
 * these only apply if it returns something unusable.
 */
export const DEFAULT_DAY_START_HOUR = envNumber("DAY_START_HOUR", 7);
export const DEFAULT_DAY_END_HOUR = envNumber("DAY_END_HOUR", 19);

/** Booking granularity in minutes. */
export const SLOT_MINUTES = envNumber("SLOT_MINUTES", 15);

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

export const CACHE_TTL_MS = {
  /** Roster changes approximately never. */
  rooms: envNumber("CACHE_ROOMS_MS", 60 * 60 * 1000),
  /** Short, because someone else may be booking right now. */
  bookings: envNumber("CACHE_BOOKINGS_MS", 30 * 1000),
} as const;

/** Per-request timeout when talking to an appliance. They are slow and old. */
export const APPLIANCE_TIMEOUT_MS = envNumber("TIMEOUT_MS", 15_000);

/**
 * Max concurrent requests to the appliance fleet. One request per room is the
 * natural ceiling; these are embedded devices and should not be hammered.
 */
export const MAX_CONCURRENCY = envNumber("MAX_CONCURRENCY", 9);

/** Hard ceiling on an availability query, in days. Each day is N more requests. */
export const MAX_RANGE_DAYS = envNumber("MAX_RANGE_DAYS", 31);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const PORT = Number(process.env.PORT ?? envNumber("PORT", 8787));

/**
 * Browser origins allowed to call this relay. The front-end is a static site
 * on a known origin, so an allowlist is appropriate.
 */
export const ALLOWED_ORIGINS: readonly string[] = envList("ALLOWED_ORIGINS", [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
