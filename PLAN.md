# RoomWizard Reserve AI — Plan

A better front-end for Steelcase RoomWizard room booking, driving the existing appliances
behind the scenes. Picker-first UI, with a self-hosted Qwen you can hand any selection to
and start talking.

Built for and tested against the **BSRL building at the University of Arizona**. The code
is site-agnostic — hostnames, timezone, hours and limits are all configuration — but BSRL
is the only installation it has actually run against.

Status: **full read + write round-trip validated live** on 2026-10-07. No unknowns left
in the integration layer.

---

## 1. What the existing system actually is

Reverse-engineered from `https://bsrl-203.arizona.edu/GroupView.action`.

| | |
|---|---|
| Product | **Steelcase RoomWizard** Scheduling Suite ("RoomWizard Room Booking Connector Classic", `rw_classic_v1`) |
| Server | Jetty 8.1.14 (2013), Apache Struts, YUI 2 front-end |
| Auth | **None.** No login, no session gate, no CSRF token, no API key |
| Topology | Each room is its *own appliance on its own hostname*; `GroupView` on any one of them aggregates the other 8 as "buddies" |
| Hours | Timeline 07:00–19:00, 15-minute granularity |
| Timezone | America/Phoenix (UTC−7, no DST) |

### The 9 rooms

| Room | Host | Cap | Location |
|---|---|---|---|
| BSRL-100 | `bsrl-100.arizona.edu` | 8 | 1st floor South near elevator |
| BSRL-153 | `bsrl-153.arizona.edu` | 10 | 1st floor North Conference Room |
| BSRL-203 | `bsrl-203.arizona.edu` | 8 | 2nd floor south behind south elevator |
| BSRL-236 | `bsrl-236.arizona.edu` | 8 | Second Floor |
| BSRL-258 | `bsrl-258.arizona.edu` | 10 | 2nd floor North Large room |
| BSRL-307 | `bsrl-307.arizona.edu` | 8 | Third Floor South West |
| BSRL-340 | `bsrl-340.arizona.edu` | 8 | 3rd Floor North |
| BSRL-350 | `bsrl-350.arizona.edu` | 10 | — |
| BSRL-450 | `bsrl-450.arizona.edu` | 10 | — |

Most rooms advertise a PTZ camera for video conferencing + an in-room Windows 10 PC.
BSRL-258 additionally has Cisco IP-based video conferencing. BSRL-340 lists no facilities.

---

## 2. The API, as verified

### Read: room roster

```
GET https://bsrl-203.arizona.edu/getGroupTimeLineJSON.action?date=YYYYMMDD
```

One call, returns all 9 rooms with capacity, location, facilities, plus timeline bounds,
timezone offset, and time format. ✅ verified.

### Read: bookings (per room)

```
GET https://bsrl-<room>.arizona.edu/Connector
      ?command=get_bookings&format=json
      &range_start_date=YYYYMMDD&range_start_time=HHMMSS
      &range_end_date=YYYYMMDD&range_end_time=HHMMSS
```

Returns `[{Id, start, end, purpose, hostFirstName, hostLastName, notes, isConfidential,
isPasswordProtected, password, creationDate, modificationDate, Attendees[]}]`.
✅ verified on all 9 hosts. `format=xml` also works (KwikBook schema).

Only `get_bookings` and `delete_booking` are recognized as `command=` values; everything
else returns empty. There is no `create_booking` on the Connector — creation goes through
Struts.

### Write: create a booking

```
POST https://bsrl-<room>.arizona.edu/saveBooking.action
```

✅ **verified** — created a 18:45–19:00 booking on BSRL-340, confirmed it via
`get_bookings` (Id 3425), then deleted it. Room returned to empty.

The flow the real UI uses, and that we replicate:

1. `GET /BookingForm.action?display_date=YYYYMMDD&start_time=HHMMSS&end_time=HHMMSS`
   — establishes `JSESSIONID` and returns the form with ~77 fields and their defaults.
2. POST all of those fields back to `saveBooking.action`, overriding the handful we care
   about. (`updateBooking.action` is the edit equivalent, keyed on `booking_id`.)

Success = 302 to `GroupView.action`. Failure = the form re-renders with messages in
`errorMsgDiv2` or a hidden `error` field. Carrying the full default field set forward
matters; the Struts action is not tolerant of a minimal body.

**What's actually required.** The form self-describes this via hidden flags
(`required=true`, `hostRequired=true`, `purposeRequired=true`, everything else `false`):

| Field | Required? | Notes |
|---|---|---|
| `purpose` | **yes** | max 50 chars |
| `hostFirstName` / `hostLastName` | **yes** | validator needs *one* non-empty; free text, unverified |
| `startTime`,`startDate`,`startMonth` | yes | `HHMMSS` / `DD` / `YYYYMM` |
| `endTime`,`endDate`,`endMonth` | yes | same |
| `password`, `repeatPassword` | no | per-booking edit/delete PIN |
| `user1`,`user2`,`user3` | no | invitees |
| `repeatType` | no | `none` / `every` / `on` + recurrence selects |
| phone, email, notes, cost center, confidential, services | **disabled on this install** | all `show*=false` |

So a reservation is really **purpose + a name + start + end.** The current UI makes you
walk a 50-field form for four values.

### Write: delete a booking

Three-step chain, all ✅ verified:

```
POST /validateBookingPassword.action   booking_id + password  -> showDeleteButton=true
POST /populateDelete.action            (full form body)       -> confirmation page
POST /deleteBooking.action             (full form body)       -> 302 GroupView
```

`Connector?command=delete_booking` is recognized but returns `result_code 1` for every
param shape tried — use the Struts chain.

### Date/time formats

The appliance speaks five formats for the same concept: `20261007` (dates), `140000`
(times), `2026/10/07 14:00:00` (JSON responses), `DD` + `YYYYMM` (form selects), and
`1800` (rejected — `BookingForm.action` throws `Unparseable date: "1800"`). Normalizing
all of this exactly once, in the relay, is a large share of this project's value.

---

## 3. What can and cannot be hosted

Three measured facts decide the whole architecture.

### (a) The appliances are on private IPs

```
bsrl-203.arizona.edu -> 10.a.b.74     (RFC1918, campus-internal)
bsrl-100.arizona.edu -> 10.a.b.83
```

These names resolve to the *same* RFC1918 addresses from Google, Cloudflare, and Quad9
public DNS — so the hostnames are globally resolvable but the addresses are only routable
from UAWiFi / the UA VPN. There is no public BSRL booking portal
(`roomwizard.arizona.edu` and `rooms.arizona.edu` don't exist).

**Therefore: no public cloud backend can ever reach them.** Cloudflare Workers, Vercel,
Netlify, Deno Deploy, Fly.io, GitHub Actions runners — all sit on the public internet and
cannot route to RFC1918 space. This is not a configuration problem; it's addressing.
Something on the campus network has to make the final hop. That piece cannot be hosted
for free on the internet, and no amount of architecture avoids it.

### (b) But a browser on campus *can* reach them

The cert is real — `CN=bsrl-203.arizona.edu`, issued by InCommon/Internet2, valid to
2027-04-18. So no cert warnings, no trust prompts.

TLS support is narrow: **TLS 1.2 only, no TLS 1.3, and no ECDHE suites at all.** The
appliance offers `DHE-RSA-AES128-GCM-SHA256` (whose DH parameters are below the modern
floor) and legacy `AES128-SHA` static RSA. Browsers negotiate that last suite, which is
why your browser loads the site fine while Python 3.14 refused with
`SSL: DH_KEY_TOO_SMALL`.

So reachability is *not* the browser's problem. **CORS is.** The appliances send no
`Access-Control-Allow-Origin` and set `X-Frame-Options: DENY`, so a hosted static page
can issue requests but can never read the responses. A cross-origin `<form>` POST would
go through, but availability could never be read, so that's a dead end.

### (c) The model is not the hard part

A self-hosted Qwen runs wherever we like, including on the relay box itself. Worth noting
for whenever a managed provider is reconsidered: never let the frontend call a keyed LLM
API directly. A static site's JavaScript is fully public, scanners watch GitHub Pages
bundles for keys, and it would get scraped and billed within days. Self-hosting sidesteps
this — there is no key to leak.

### What this adds up to

| Piece | Hostable? | Where |
|---|---|---|
| UI | ✅ fully | GitHub Pages, free |
| Model + chat history | ✅ fully | alongside the relay, or any OpenAI-compatible endpoint |
| **Final hop to the appliances** | ❌ never | one relay on campus |

The off-campus-impossible surface is **one relay**. Not your laptop, not per-user — one
instance the whole lab shares.

---

## 4. Architecture

```
┌────────────────────────────────────────┐
│  GitHub Pages (static, free, public)   │   React + Vite + Tailwind
│  picker  ⇄  chat                       │
└────────────────┬───────────────────────┘
                 │  HTTPS/JSON          (campus / VPN only)
┌────────────────▼───────────────────────┐
│  Relay (Node + Hono)                   │   one instance, shared
│  bsrl-api.<yourdomain>                 │   - RoomWizard proxy + normalizer
│                                        │   - lenient TLS to appliances
│                                        │   - tool loop + chat routes
│                                        │   - SQLite: conversation history
└──────┬─────────────────────────┬───────┘
       │                         │
       ▼                         ▼
┌──────────────────┐   ┌──────────────────────────────┐
│ LLM endpoint     │   │ 9 × RoomWizard (RFC1918)     │
│ OpenAI-compatible│   └──────────────────────────────┘
│ Ollama → hosted  │
└──────────────────┘
```

One backend, not two. Because the model is reached over an OpenAI-compatible HTTP API,
*where* it runs is a single environment variable rather than an architectural decision:

| Stage | `LLM_BASE_URL` | Cost |
|---|---|---|
| Now, development | `http://localhost:11434/v1` (Ollama, `qwen3:4b`) | $0 |
| Later, shared | a small box running Ollama or llama.cpp alongside the relay | $0 if the relay host has the RAM |
| Later, managed | DeepInfra / Together / Novita, which serve Qwen over the same API | cents per million tokens |
| Later, bursty | a serverless GPU (Modal, RunPod) — near-zero idle cost | pay per second |

`qwen3:4b` quantized is ~3 GB, so it fits beside the relay on an ordinary machine. Nothing
in the code changes between those rows; a managed Qwen endpoint and a local Ollama are the
same two lines of client code.

### Why the relay runs the tool loop

The relay is the only component that can reach both the appliances and the model, so it
owns the loop: it calls the LLM, executes any tool call against its own room functions
in-process, and iterates. That keeps tool execution server-side where it can be validated,
and keeps the browser a thin client.

The earlier draft of this plan had the browser orchestrating the loop across two separate
backends. Collapsing to one relay removes that complexity entirely — the only reason for
the split was keeping a hosted provider's API key off the client, and a self-hosted model
has no key to protect.

### Hosting each piece

| Piece | Where | Free? |
|---|---|---|
| UI | GitHub Pages, deployed by Actions | yes |
| Relay + chat + history | one campus box (see below) | yes |
| Model | Ollama on that same box | yes |

### Where the relay actually runs

It needs to be on the campus network and always on. In rough order of preference:

1. **A department / Research Computing VM.** Worth one email. Most defensible, someone
   else keeps it patched, survives you graduating. Ask for enough RAM to hold the model.
2. **A lab machine or a mini PC on UAWiFi.** Fine for a lab.
3. **Your workstation.** Works, but the app is down whenever your machine sleeps.

For users to reach it from an HTTPS page without mixed-content errors, the relay needs
HTTPS on a name with a valid cert. Point an A record for `bsrl-api.<yourdomain>` at the
relay's campus IP and get a Let's Encrypt cert by DNS-01 challenge — the cert works even
though the address is private, because DNS-01 never needs inbound reachability. UA does
exactly this for the appliances themselves. Cost: a domain, ~$10/yr. Keep the DNS record
unproxied; a Cloudflare orange-cloud proxy would try to reach the private IP and fail.

### A route I'd advise against for now

A Cloudflare Tunnel from the relay would give a public hostname that works off-campus
with no VPN, free. It's tempting and it is the only way to drop the VPN requirement.

But it means **publishing a gateway into an internal, wholly unauthenticated campus
system onto the public internet**, where anyone could create and delete BSRL bookings.
That is very likely contrary to UA IT security policy, and it's the kind of thing that
lands on someone's desk as an incident rather than a feature. If you want it, gate it
behind Cloudflare Access restricted to `@arizona.edu` accounts (free up to 50 users) and
clear it with BSRL IT first. You already said assuming UAWiFi/VPN is fine, so I'd ship
without the tunnel and revisit only if people actually ask.

---

## 5. The interface

### Picker first

A week grid — all 9 rooms, 7 days, drag to select. This is the primary way to book, not a
fallback for the chat.

| RoomWizard today | This app |
|---|---|
| One day at a time, arrow-click to move | Week view, 9 rooms × 7 days in one grid |
| No capacity or equipment filter | Filter chips: ≥N people, camera, PC, floor |
| 50-field form for a 30-minute meeting | Drag a slot → purpose → done |
| Your name retyped every single time | Saved profile, prefilled |
| No "what's free at 2pm Thursday?" | Slot finder: duration + window → ranked options |
| Reservations list is a separate search form | My-bookings panel |
| Breaks on mobile | Responsive |

### Selection is chat context

The integration you described: **whatever is selected in the picker is live context for
the chat.** Select Thursday 2–4pm on BSRL-258 and "is there anything bigger?", "move this
to Friday", "book it, call it lab meeting" all resolve against that selection without
restating it. A compact state blob (selection, visible range, active filters, profile) is
injected as a system message each turn; the model's tool calls write back into the same
state, so the grid updates as it talks. Clicking the grid mid-conversation just updates
context — no reset.

Conversation history lives in SQLite on the relay, keyed by a stable per-user id, so
threads persist and resume across devices.

### Designing around a small model

A 4B model is unreliable at multi-constraint search, so the work goes into TypeScript,
not the prompt:

- **The slot finder is a tool, not a prompt.** Capacity/equipment/time filtering and
  ranking happen in code. The model picks among pre-computed candidates instead of
  reasoning over 9 rooms × 48 slots.
- **Narrow tools, flat arguments.** `find_slots`, `get_availability`, `create_booking`,
  `cancel_booking`. No nested objects, enums over free strings, relative dates resolved
  server-side ("tomorrow" → `2026-10-08`) before the model sees them.
- **Sliding window + rolling summary** so long threads don't blow context.
- **The model proposes; the human confirms.** Writes always render a confirmation card
  with parsed details and commit only on click. Non-negotiable for a shared resource.

---

## 6. Build phases

Phase 0 (validate the write path) is **done** — see §2.

**Phase 1 — relay, read path.** Node 20 + Hono. TLS agent pinned to `AES128-SHA` scoped
to `bsrl-*` hosts only. `/api/rooms` + `/api/availability`, 9-way parallel fan-out,
caching, date normalization. CORS allowlist for the Pages origin. Vitest against recorded
fixtures so CI never touches the appliances. Dockerfile, so step 3 of §4 is a one-liner
wherever the box ends up.

**Phase 2 — picker UI, read-only.** Vite + React + Tailwind on Pages. Week grid, filters,
room detail. Relay URL from build config, overridable in settings. Ship it — already
better than the current site with zero write capability.

**Phase 3 — booking.** `POST /api/book`, drag-to-select, confirm modal, saved profile,
my-bookings. Re-validate availability relay-side immediately before writing: the
read→write gap is a real double-book risk, and RoomWizard will happily let two people
claim the same slot.

**Phase 4 — slot finder.** Deterministic ranking (`find_slots`). Useful on its own, and
the tool the model leans on hardest.

**Phase 5 — chat.** Ollama + relay-side tool loop + SQLite history +
selection-as-context + confirmation cards.

Phases 1–4 don't touch the model at all, so the LLM choice can't block shipping something
useful — and it stays a config change afterwards.

---

## 7. Things to be careful about

Operational and security notes for this deployment live in `SECURITY-NOTES.md`, which is
deliberately **not committed** (see `.gitignore`). It covers a disclosure item that should
go to BSRL IT before this repo gets wider attention.

The constraints that shape the code, which are safe to state here:

- **Never forward appliance-supplied credential material to clients.** The relay strips
  it in `normalizeBooking`, with a test asserting it never appears in a response. Do not
  add it back.
- **Scope writes to bookings this app created.** Read all rooms — the appliance's own
  group view is already public — but there is no "cancel anyone's reservation" feature,
  and there should not be one.
- **Set a strong random booking password** on everything we create, stored server-side,
  never displayed.
- **Rate-limit ourselves.** 2013-era embedded appliances on a 12-year-old Jetty. Cache
  aggressively, cap fan-out at one request per room, never poll tighter than ~30 s. One
  shared relay helps: it's a natural chokepoint and a shared cache, far gentler than
  every browser polling independently.
- **Shared relay means shared attribution.** Every booking originates from one IP. That's
  one machine making everyone's reservations, which is a reason to tell BSRL IT what
  you're building rather than have them find it.
- **Keep hostnames and addresses in relay config**, not in the README.
- **Ask BSRL whether a nicer front-end is welcome.** Reading endpoints that are already
  unauthenticated is no more privileged than loading their website, but a tool that makes
  booking easier shifts room contention, and they may have opinions. Cheap to ask,
  awkward to retrofit.

---

## 8. Stack

- **Front-end:** React 18, Vite, TypeScript, Tailwind, TanStack Query, `date-fns-tz`
  pinned to `America/Phoenix`. GitHub Actions → Pages.
- **Relay:** Node 20, Hono, Zod, `undici` with a custom TLS agent, `node-html-parser` for
  Struts responses. Stateless, containerized.
- **Model:** any OpenAI-compatible endpoint. `qwen3:4b` on Ollama for development;
  `LLM_BASE_URL` points elsewhere later without code changes.
- **Chat history:** SQLite on the relay (`better-sqlite3`).
- **Repo:** npm workspaces — `web/` + `relay/`.
