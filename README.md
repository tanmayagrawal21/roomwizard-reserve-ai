# RoomWizard Reserve AI

An AI-assisted front-end for **Steelcase RoomWizard** conference-room booking: a fast
picker UI plus a local LLM you can talk to, both driving the existing appliances behind
the scenes.

Built for and **tested against the BSRL building at the University of Arizona** (9 rooms,
`RoomWizard Room Booking Connector Classic` / `rw_classic_v1`). Nothing is hardcoded to
that building, though — the appliance hostnames, timezone, bookable hours, and load
limits are all configuration. Pointing it at another RoomWizard installation should take
two environment variables, but **that path is untested**; see
[Other installations](#other-installations).

See [PLAN.md](PLAN.md) for the reverse-engineering notes, the verified appliance API, and
the build plan.

## Status

**Phases 1-2 complete** — the relay and a read-only picker UI, both verified against the
live BSRL fleet.

| Phase | What | State |
|---|---|---|
| 0 | Validate the appliance write path | ✅ verified live |
| 1 | Relay: roster + availability | ✅ done, 79 tests |
| 2 | Picker UI | ✅ done |
| 3 | Booking (writes) | next |
| 4 | Slot finder | — |
| 5 | Chat (local Qwen via Ollama) | — |

Booking is not wired up yet, so the UI is currently read-only: you can see every room's
day at a glance and filter down to the ones that suit, but you still reserve through the
appliance's own page.

## Why there is a relay

The appliances sit on private (RFC1918) campus addresses and send no CORS
headers. So:

- A static site **cannot** read them directly — no `Access-Control-Allow-Origin`.
- A public cloud backend **cannot** reach them at all — the addresses aren't routable off
  campus. Cloudflare Workers, Vercel, Netlify, GitHub Actions runners: all useless here.

The relay is the one piece that must sit on the building's network. It is stateless,
holds no secrets, and one instance serves everybody. **It must run on the campus network
or VPN.**

## Running it

Requires Node 20+. **You must be on the building's network or its VPN** — the appliances
are on private addresses, so nothing works off-network.

Two processes, two terminals:

```bash
npm install

# Terminal 1 - the relay (talks to the appliances)
npm run dev                  # http://localhost:8787

# Terminal 2 - the web UI
npm run dev:web              # http://localhost:5173
```

Then open <http://localhost:5173>. The UI defaults to a relay at
`http://localhost:8787`; if yours is elsewhere, use the **Relay** button in the top right
rather than rebuilding.

To configure a non-BSRL installation, `cp relay/example.env relay/.env` and edit. The
`dev` and `start` scripts load it automatically.

### Checks

```bash
npm test          # 79 relay tests, no network access needed
npm run typecheck
npm run build
```

### Docker

The relay is containerized for running on a host inside the building's network:

```bash
docker build -f relay/Dockerfile -t rw-relay .
docker run -p 8787:8787 --env-file relay/.env rw-relay
```

### Deploying the UI

`.github/workflows/pages.yml` publishes `web/` to GitHub Pages on push to `main`. Enable
Pages for the repo with **Source: GitHub Actions** first.

Add the Pages origin to `RW_ALLOWED_ORIGINS` on the relay (scheme and host only), or
the browser refuses the responses.

**The hosted page cannot reliably reach a relay on `http://localhost`.** Chrome gates
requests from a public page into the loopback address space behind Local Network Access:

```
Access to fetch at 'http://localhost:8787/api/rooms' from origin
'https://you.github.io' has been blocked by CORS policy: Permission was denied
for this request to access the `loopback` address space.
```

The relay opts in on the preflight (`Access-Control-Allow-Local-Network`, plus the older
`...-Private-Network` spelling), but that is only half of it — the browser also requires
the user to grant a permission prompt, and other browsers take their own positions.

So, in practice:

- **For yourself**, run the UI locally with `npm run dev:web`. Localhost to localhost is
  not gated, and this is the path that is actually verified working.
- **For a shared deployment**, give the relay a real hostname with a valid certificate
  on the building's network and set the repo variable `RELAY_URL`. A public DNS A record
  pointing at a private address works fine with a Let's Encrypt DNS-01 certificate — it
  is what the appliances themselves do.

The Pages deployment is still useful as the canonical build and for anyone who has
configured a proper relay address.

## What the UI does

A week strip with a density bar per day, so you can see at a glance that Thursday is
packed and Friday is open — the thing the appliance's own interface makes you arrow
through blindly. Picking a day shows all rooms as timelines across the bookable window,
with the current time marked.

Filter chips narrow by seats, equipment (camera, in-room PC, Cisco VC, audio conf),
floor, and whether a room has an unbroken free gap of at least 30m / 1h / 2h. Each row
also shows its longest gap and the actual free windows as text.

Rooms whose appliance didn't answer are shown as "couldn't read this room's schedule"
rather than as empty — "free" and "unknown" are different claims and the UI shouldn't
conflate them.

## Relay API

### `GET /healthz`

### `GET /api/rooms`

The fleet: id, name, capacity, inferred floor, amenity tags, and the bookable window.

```json
{
  "site": "BSRL",
  "rooms": [
    {
      "id": "bsrl-258",
      "name": "BSRL-258",
      "capacity": 10,
      "floor": 2,
      "location": "Second floor North Large room",
      "amenities": ["camera", "pc", "cisco_vc", "audio_conf"],
      "online": true
    }
  ],
  "dayStartHour": 7,
  "dayEndHour": 19,
  "slotMinutes": 15,
  "timezone": "America/Phoenix"
}
```

### `GET /api/availability?from=&to=&days=`

Free/busy for every room. `from` and `to` accept a bare local date (`2026-10-08`), a
naive local datetime, or a fully-qualified ISO string; `days` sets the span when `to` is
omitted. Range capped at `RW_MAX_RANGE_DAYS` (default 31).

Each room gets a `busy` list (the bookings) and a `free` list (the gaps, already clipped
to bookable hours). Rooms that fail to answer appear in `errors` rather than silently
showing as empty, so the UI can tell "nothing booked" from "we don't know".

All timestamps are ISO 8601 with an explicit offset, computed per instant — so zones that
observe DST are handled correctly even though BSRL's does not.

## Other installations

Set two variables and the rest is discovered from the appliance roster at runtime (room
list, capacities, locations, facilities, bookable window):

```bash
RW_ROSTER_HOST=https://some-room.example.edu/   # any one appliance in the group
RW_TIMEZONE=America/New_York                    # IANA zone the appliances are in
```

`RW_TIMEZONE` is not optional anywhere outside Arizona. The appliances report wall-clock
times with **no offset**, so it is the only way to interpret them — and Arizona's lack of
DST is exactly the kind of thing that hides this bug until someone deploys elsewhere.
Timezone handling is covered by tests against New York (DST), Asia/Kolkata (`+05:30`),
Berlin, and UTC.

See [relay/example.env](relay/example.env) for everything else. Legacy `BSRL_*` names
are still honoured as a fallback.

Two caveats for a new site: the TLS workaround below is pinned to hostnames under
`RW_HOST_SUFFIX`, and floor inference assumes room numbers encode the floor
(`BSRL-203` → 2), falling back to ordinals in the location text ("3rd Floor North") and
to `null` when neither applies.

## Notes for anyone picking this up

- **Booking credential fields are never forwarded.** The appliance includes
  per-booking credential material in its responses. The relay strips it in
  `normalizeBooking`, with a test asserting it never appears in output. Do not add it
  back. See [PLAN.md](PLAN.md) §7.
- **The appliances need lowered TLS.** They speak only TLS 1.2 with no ECDHE, so Node
  needs `ciphers: 'DEFAULT:@SECLEVEL=0'` or the connection fails with
  `ERR_SSL_DH_KEY_TOO_SMALL`. Certificate verification stays **on** — the certs are
  real and valid. The permissive agent is scoped to appliance hostnames only; see
  [relay/src/tls.ts](relay/src/tls.ts).
- **The Connector ignores the time parts of its range.** Ask for one day and you get
  whole days back, including the next one. `overlapsRange` in
  [relay/src/availability.ts](relay/src/availability.ts) filters the surplus. This was
  only visible against live data.
- **Tests use synthetic fixtures**, deliberately. Recording live responses would commit
  real people's names and their bookings' password hashes into the repo.
- **Be gentle.** These are 2013 embedded appliances running Jetty 8. Fan-out is capped at
  one request per room, responses are cached, and concurrent identical requests are
  coalesced into a single fan-out.
