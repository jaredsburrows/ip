# ip

Shows your IP address and client/request information.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Build](https://github.com/jaredsburrows/ip/actions/workflows/build.yml/badge.svg)](https://github.com/jaredsburrows/ip/actions)
[![Twitter Follow](https://img.shields.io/twitter/follow/jaredsburrows.svg?style=social)](https://twitter.com/jaredsburrows)

An `index.html` page with shared browser helpers (`ip-info.js`), an on-demand
live globe (`globe-ui.js`), and a small Worker API (`worker.js`, `location.js`,
`globe.js`) — no build step. One origin serves everything:
<https://ip.jaredsburrows.workers.dev/>

The page reads `GET /api/info`, a Worker endpoint that echoes what the server
sees: the HTTP method, every request header, and Cloudflare's `request.cf` data
(IP, ASN/ISP, city-level geolocation, TLS details, RTT). Static assets are served
free from the edge — only the listed API paths invoke the Worker
(`run_worker_first` in `wrangler.jsonc`). The page always calls the API
same-origin, so the API sends no CORS headers and rejects cross-origin browser
callers. Independent browser requests to [ipify](https://www.ipify.org/) detect
IPv4 (`api.ipify.org`) and IPv6 (`api64.ipify.org`), and provide the headline IP
fallback if the Worker is unavailable. Failed checks say "not detected";
they do not prove that a device has no address of that family.

### Location and public IP

- The initial country → state/region → city comes from Cloudflare's
  IP-based estimate. It preserves the returned city, with no nearest-metro
  substitution. The Cloudflare datacenter is shown separately.
- Public IP comes from `CF-Connecting-IP`. In Pseudo IPv4 overwrite mode,
  the Worker uses the preserved `CF-Connecting-IPv6`; synthetic Class E IPv4
  addresses are never presented as real IPv4. VPNs/proxies expose their exit
  IP; the site cannot discover a home/private address behind them.
- Country flags use that IP's country, with readable country names. The
  separately probed addresses only get a flag when they match the Worker IP.
- "Use device location" requests browser permission and displays coordinates
  with the reported accuracy. Coordinates stay in the browser by default.
- When configured, an unchecked "Also find my city" option allows coordinates
  to be sent to `POST /api/location` and then Geoapify. Successful city lookup
  takes priority in the location summary; network fields retain their IP-based
  values. Denial or lookup failure retains the IP estimate. Neither method
  guarantees an exact physical location.

Cloudflare's `request.cf` is the primary source. For a zone with the
"Add visitor location headers" managed transform enabled, you may set the
Worker variable `TRUST_LOCATION_HEADERS` to `"true"` to fill missing geographic
fields from those headers. Leave it unset on workers.dev or other deployments
where that transform is not configured; arbitrary incoming headers are not
trusted by default.

### Live globe (opt-in)

"View live globe" opens a 3D globe of everyone currently sharing an approximate
area. Nothing globe-related is downloaded until that button is pressed: the
page's only addition is the handler that dynamically imports `globe-ui.js`,
which then loads the vendored `vendor/globe.gl-2.46.2.min.js` and Earth
texture (see `vendor/PROVENANCE.md` for versions, hashes, and licenses).
Vendoring keeps the CSP unchanged and keeps a third-party CDN out of the
serving path. Those filenames carry a version or a content hash, so `_headers`
can cache them `immutable` without ever stranding a browser on a stale copy.

Opening the globe makes you a viewer only. An unticked "Share my approximate
area on the globe" checkbox is the only thing that publishes a pin, and:

**What a pin actually is.** It is an approximate point on a public map, worked
out from the IP address of the connection. The response carries no city,
region, or country string — but that is a statement about the JSON, not about
what is disclosed: anyone can look up which country, and roughly which part of
it, a published point falls in. What limits the disclosure is how coarse the
point is and how few of them exist, so those are stated plainly below rather
than dressed up as "no location is shared".

- Coordinates come from Cloudflare's `request.cf` for that request. The browser
  Geolocation API is never used here and the client cannot submit a position at
  all, so nobody can place a pin where their connection is not.
- The position is snapped server-side to the centre of a grid cell that is
  ~111 km across at every latitude. Rows are 1° tall and the number of columns
  in a row follows cos(latitude), so a cell does not narrow to 38 km at 70°N
  the way a fixed 1° longitude step would; near the poles a whole parallel
  becomes one circumpolar cell.
- **Nobody is published alone at that size.** A cell is only shown at ~111 km
  once at least 5 people share it. Below that threshold it is not dropped, it
  is *rolled up*: into a ~1,100 km cell, published if that clears 5, and
  otherwise into a continent-sized (~4,400 km) cell, which is published
  whatever it holds. A solitary visitor therefore appears as a continent, never
  as a city — and the globe still shows something at this site's traffic level,
  which plain suppression would not.
- **Counts are ranges, never integers.** A point is
  `{lat, lon, count: "1-4" | "5-9" | "10-24" | "25-49" | "50+"}` — no city,
  region, country, IP, user agent, or timestamp, and nothing joinable to
  another dataset. An exact count is an identifier when it is small and a
  traffic meter when it is large, so the wire format has no way to carry one.
- Presence lives in one Durable Object's memory with a 5-minute TTL and is never
  written to storage, KV, or logs; expired entries are swept on every request.
  Unticking the box, closing the overlay, or leaving the page removes the pin
  immediately, and an abandoned tab ages out within the TTL. The public
  aggregate is edge-cached for 10 seconds, so a removal can take that long to
  disappear from other people's screens.
- The only per-visitor value is a random `crypto.randomUUID()` held in page
  memory (never `localStorage`, `sessionStorage`, or a cookie) to dedupe
  heartbeats.

`GET /api/globe/positions` is public and read-only; `POST`/`DELETE
/api/globe/presence` take a token and nothing else. Abuse is bounded
structurally — server-derived coordinates plus hard caps in the Durable Object:
200 pins per cell, 20 concurrent pins per source (an IPv4 address or an IPv6
/64, stored only as a salted in-memory hash), and 2,000 globally. The global
cap evicts the oldest pin in the fullest cell rather than refusing everyone
new, so a filled map cannot be used to lock genuine visitors out. Every method
is rate limited on top of that — `GLOBE_LIMITER` for writes, the far more
generous `GLOBE_READ_LIMITER` for reads — and positions are served from a
10-second edge cache so routine polling never reaches the Durable Object at
all.

**Retiring the globe (one-way door).** The `globe-presence-v1` migration in
`wrangler.jsonc` must never be deleted or renumbered: migrations are
append-only, so reverting that hunk makes `wrangler deploy` fail and blocks
every deploy from this repo, including unrelated ones. To remove the feature,
in a single commit, drop the `GLOBE` binding and the `GlobePresence` export and
*append* `{ "tag": "globe-presence-v2", "deleted_classes": ["GlobePresence"] }`
to the migrations array. There is no data to purge either way — presence is
RAM-only.

### Optional device city lookup

Create a [Geoapify](https://www.geoapify.com/) API key and store it as a Worker
secret (never in source or command arguments):

```
npx wrangler secret put GEOAPIFY_API_KEY
```

For local preview, put the key in an ignored `.dev.vars` file. Without the
secret, city lookup is hidden and its endpoint returns 503; Cloudflare location
and opt-in device coordinates still work. Two `wrangler.jsonc` rate-limit
bindings guard the endpoint at each Cloudflare location: `LOCATION_LIMITER`
allows 10 lookups per minute per client — counted per IPv4 address, or per
IPv6 /64 so that rotating inside one prefix does not reset the counter — and
`LOCATION_LIMITER_COARSE` caps everyone together at 60 per minute. Users
sharing an address or prefix share the allowance. Both are abuse guards, not a
global Geoapify quota cap; configure provider spend controls separately.

The endpoint validates coordinate ranges, limits request/response sizes,
times out provider calls, and returns `Cache-Control: no-store`. Application
code does not store or log coordinates, provider URLs, or the API key. Selecting
city lookup shares coordinates with Cloudflare and Geoapify; provider handling
is governed by their policies. Attribution is displayed next to the result.

Security headers live in `_headers`, and the CSP is repeated as a meta tag in
both pages so it still applies to a local preview or a saved copy that has no
response headers — keep all three copies in sync. `.assetsignore` decides which
repo files the Worker uploads as assets (`worker.js`, `location.js`, `tests/`
and friends are excluded); it is a "do not publish" list, not a secret store —
keys belong in `wrangler secret put` and `.dev.vars` (git-ignored).

### Preview the website

Serve the directory (ES modules require HTTP rather than opening `file://`):

```
python3 -m http.server
```

For a Cloudflare-accurate preview (applies `_headers`, the 404 page, and the
API endpoints):

```
npx wrangler dev
```

Note that `request.cf` is only partially simulated locally — geolocation and TLS
values are real only on the deployed Worker, and the connecting IP can be a
loopback address such as `::1`. If an edit doesn't show up,
hard-refresh (Cmd+Shift+R) — the browser may cache JS/CSS between refreshes.

### Deploy

Push to `gh-pages` (the default branch, kept for its name only). GitHub Actions
validates and then deploys those files to Cloudflare Workers
(`.github/workflows/build.yml`). Manual deploy: `npx wrangler deploy`.

### Tests

Use Node.js 22 or newer; no dependency installation is needed for tests:

```
npm test
```

Tests cover existing request metadata, origin rejection, routing and HEAD
behavior;
IP validation and Pseudo IPv4; flags; IPv4/IPv6 probe failures and timeouts;
opt-in browser flows and fallback ordering; city lookup validation, rate
limiting and upstream failure; the globe's grid snapping, TTL sweep, caps,
presence routes and lazy loading; and CSP/asset exclusions. Network services and
Cloudflare bindings are mocked, so no credentials or location sharing are
needed. They do not validate the accuracy of a provider's live geolocation.

CI runs these tests on every PR before HTML validation and the Wrangler
deployment dry run. Production deployment still runs only on `gh-pages`.

License
=======

```
Copyright (C) 2026 Jared Burrows

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
