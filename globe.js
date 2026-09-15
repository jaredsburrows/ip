/*
 * Live globe presence — pure logic.
 *
 * Privacy model (see .team/PRD.md): the only per-visitor datum handled here is
 * a client-generated random token plus a grid cell derived server-side from
 * request.cf. Nothing in this module accepts, stores, or returns an IP, a user
 * agent, a precise coordinate, or any city/region/country string, so there is
 * no join key to leak. Coordinates are snapped to the centre of a ~111 km
 * cell before they are ever written down, and a cell is only ever published
 * once enough people share it (or, failing that, merged into a much larger
 * one) — see aggregatePoints.
 */

import { limiterKey as ipBucket } from "./location.js";

// A pin lives this long after its last heartbeat.
export const TTL_MS = 300000;
export const TTL_SECONDS = TTL_MS / 1000;

// Client cadence, echoed to the browser so the two never drift apart.
export const HEARTBEAT_SECONDS = 60;
export const POLL_SECONDS = 30;

// Structural abuse bounds. These, plus server-derived coordinates, are the
// real limits on the public write endpoint — not the rate limiter (SEC-1).
export const MAX_TOKENS = 2000;
export const MAX_PER_CELL = 200;
// Concurrent pins from one rate-limit bucket (an IPv4 address or an IPv6 /64).
// Without it a handful of hosts could hold every slot in the global map and
// lock out everyone genuine (GSEC-5); with it, filling MAX_TOKENS needs at
// least 100 distinct sources.
export const MAX_PER_SOURCE = 20;

// Smallest group that may be shown at its own size. A cell holding fewer than
// this many people is never published at fine granularity: it is rolled up
// into a coarser cell instead, because a count of one at city scale is one
// identifiable person rather than a statistic (GSEC-1).
export const K_ANONYMITY = 5;

// Cell geometry. Rows are GRID_DEGREES tall at every latitude, but the number
// of columns in a row follows cos(latitude) so a cell stays ~111 km wide from
// the equator to the poles. A fixed 1-degree longitude step does the opposite —
// 111 x 111 km at the equator but 111 x 38 km at 70N — handing the *smallest*
// cells to the sparsest places, which is exactly where a lone visitor is
// easiest to pick out. Narrower is less coarsening, not more (GSEC-7).
export const GRID_DEGREES = 1;
// Roll-up ladder for cells under the floor: ~111 km, then ~1,100 km, then
// continent-sized.
export const COARSE_DEGREES = 10;
export const CONTINENT_DEGREES = 40;
const GRID_LADDER = [GRID_DEGREES, COARSE_DEGREES, CONTINENT_DEGREES];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Accepts the exact shape `crypto.randomUUID()` produces and nothing else.
 * Tokens are opaque to the server: never logged, never persisted, never echoed.
 */
export function isUuid(token) {
  return typeof token === "string" && UUID_V4.test(token);
}

// request.cf.latitude/longitude arrive as strings at the edge and are absent
// under `wrangler dev`, so parse defensively and reject anything unusable.
function coordinate(raw, limit) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

// Keeps cell centres exact (fractional steps would otherwise drift in binary).
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

const RADIANS = Math.PI / 180;

/**
 * Centre latitude of the row a point falls in. A row that runs into a pole is
 * clipped by it, so it is centred on what is left of it rather than on a
 * latitude that does not exist.
 */
function rowCentre(lat, step) {
  let row = Math.floor(lat / step);
  // Latitude 90 belongs to the row below it, not to a row of its own.
  if (row * step >= 90) row -= 1;
  return round((Math.max(row * step, -90) + Math.min((row + 1) * step, 90)) / 2);
}

/**
 * How many columns that row is cut into. Scaling by cos(latitude) is what
 * keeps a cell about as wide as it is tall at every latitude. Near a pole the
 * whole parallel is shorter than one cell, so it becomes a single circumpolar
 * cell rather than a ring of slivers.
 */
function columnsInRow(latCentre, step) {
  return Math.max(1, Math.round((360 / step) * Math.cos(latCentre * RADIANS)));
}

/** Centre of the `step`-degree cell containing a point. */
export function cellCentre(lat, lon, step) {
  const latitude = rowCentre(lat, step);
  const columns = columnsInRow(latitude, step);
  const width = 360 / columns;
  let column = Math.floor((lon + 180) / width);
  // +180 and -180 are the same meridian, so they must share one cell.
  if (column >= columns) column = 0;
  return { lat: latitude, lon: round(-180 + column * width + width / 2) };
}

/**
 * Snap a coordinate pair to the centre of its ~111 km cell.
 * Returns null when the pair is missing or out of range.
 */
export function snapToGrid(rawLat, rawLon) {
  const lat = coordinate(rawLat, 90);
  const lon = coordinate(rawLon, 180);
  if (lat === null || lon === null) return null;
  const centre = cellCentre(lat, lon, GRID_DEGREES);
  return { ...centre, cellKey: `${centre.lat}:${centre.lon}` };
}

/**
 * Drop every expired entry from a presence map. Called on each Durable Object
 * request, which is why no alarm and no storage write is needed.
 */
export function sweepExpired(tokens, nowMs) {
  let removed = 0;
  for (const [token, entry] of tokens) {
    if (!entry || entry.expires <= nowMs) {
      tokens.delete(token);
      removed += 1;
    }
  }
  return removed;
}

/** Live tokens in one cell, optionally ignoring a token that is about to move. */
export function cellCount(tokens, cellKey, ignoreToken) {
  let count = 0;
  for (const [token, entry] of tokens) {
    if (token !== ignoreToken && entry.cellKey === cellKey) count += 1;
  }
  return count;
}

/** Live tokens published from one source bucket. */
export function sourceCount(tokens, sourceId, ignoreToken) {
  let count = 0;
  for (const [token, entry] of tokens) {
    if (token !== ignoreToken && entry.sourceId === sourceId) count += 1;
  }
  return count;
}

/**
 * Which pin to drop when the map is full and someone new arrives: the
 * least-recently-refreshed one in the most crowded cell.
 *
 * A plain global cap is a denial of pins (GSEC-5) — once it is reached nobody
 * new can ever join, so a few hosts holding 2,000 slots freeze the globe and
 * render a permanent fake crowd. Taking the slot from the fullest cell means a
 * crowd loses one pin and stays a crowd, while a fresh cell still gets in.
 */
export function evictionCandidate(tokens) {
  const sizes = new Map();
  for (const entry of tokens.values()) sizes.set(entry.cellKey, (sizes.get(entry.cellKey) ?? 0) + 1);

  let fullest = null;
  for (const [cellKey, size] of sizes) {
    // Ties break on the key so the choice never depends on iteration order.
    if (fullest === null || size > sizes.get(fullest) || (size === sizes.get(fullest) && cellKey < fullest)) {
      fullest = cellKey;
    }
  }

  let victim = null;
  let oldest = Infinity;
  for (const [token, entry] of tokens) {
    if (entry.cellKey === fullest && entry.expires < oldest) {
      oldest = entry.expires;
      victim = token;
    }
  }
  return victim;
}

/**
 * Cap check for a write. Heartbeats from a known token never consume new
 * capacity, so an established visitor cannot be pushed out by a flood. A full
 * map yields a slot rather than closing the door; `evict` names the token the
 * caller must drop first.
 */
export function admits(tokens, token, cellKey, sourceId = null) {
  if (cellCount(tokens, cellKey, token) >= MAX_PER_CELL) return { ok: false, reason: "cell" };
  if (sourceId !== null && sourceCount(tokens, sourceId, token) >= MAX_PER_SOURCE) {
    return { ok: false, reason: "source" };
  }
  if (!tokens.has(token) && tokens.size >= MAX_TOKENS) {
    const evict = evictionCandidate(tokens);
    return evict === null ? { ok: false, reason: "tokens" } : { ok: true, evict };
  }
  return { ok: true };
}

/**
 * Published counts are ranges, never integers. An exact count identifies a
 * person once it is small ("the one person in this cell") and meters traffic
 * once it is large, and neither belongs on a public endpoint.
 */
const COUNT_BUCKETS = [[50, "50+"], [25, "25-49"], [10, "10-24"], [K_ANONYMITY, "5-9"], [1, "1-4"]];

export function countBucket(count) {
  for (const [floor, label] of COUNT_BUCKETS) {
    if (count >= floor) return label;
  }
  return null;
}

/** Key of the `step`-degree cell that contains a finer cell's centre. */
function parentKey(cellKey, step) {
  const [lat, lon] = cellKey.split(":").map(Number);
  const centre = cellCentre(lat, lon, step);
  return `${centre.lat}:${centre.lon}`;
}

/**
 * Collapse the presence map into the public payload: one label-free point per
 * published cell, counts bucketed, ordered deterministically so the response
 * body carries no information about arrival order.
 *
 * The k-anonymity floor is enforced by *coarsening*, not by suppression. A
 * cell holding at least K_ANONYMITY people is published at its own ~111 km
 * size. Anything short of that is added to its ~1,100 km parent and published
 * there if the parent clears the floor; what is still short lands in a
 * continent-sized cell, which is published whatever it holds because a pin
 * that wide identifies nobody. So a solitary visitor never produces a
 * city-scale pin, and the globe still never goes blank — plain suppression
 * would leave it permanently empty at this site's traffic level, which is the
 * one thing the feature cannot survive.
 */
export function aggregatePoints(tokens) {
  let counts = new Map();
  for (const entry of tokens.values()) {
    counts.set(entry.cellKey, (counts.get(entry.cellKey) ?? 0) + 1);
  }

  const published = new Map();
  for (let level = 0; level < GRID_LADDER.length; level += 1) {
    const coarser = GRID_LADDER[level + 1];
    const rolled = new Map();
    for (const [cellKey, count] of counts) {
      // The last rung has nowhere left to roll up to.
      if (count >= K_ANONYMITY || coarser === undefined) {
        // A coarse centre can coincide with a finer one at the poles; adding
        // rather than overwriting keeps every person counted exactly once.
        published.set(cellKey, (published.get(cellKey) ?? 0) + count);
      } else {
        const parent = parentKey(cellKey, coarser);
        rolled.set(parent, (rolled.get(parent) ?? 0) + count);
      }
    }
    counts = rolled;
  }

  return [...published.entries()]
    .map(([cellKey, count]) => {
      const [lat, lon] = cellKey.split(":").map(Number);
      return { lat, lon, count: countBucket(count) };
    })
    .sort((a, b) => a.lat - b.lat || a.lon - b.lon);
}

/*
 * Durable Object: the single global presence map.
 *
 * Deliberately RAM-only. There is no `ctx.storage` call, no alarm, and no
 * logging anywhere in this class, so presence data never reaches disk, KV, or
 * an observability pipeline — it cannot outlive the isolate, let alone the
 * 5-minute TTL. If the object is evicted, pins simply repopulate from the next
 * round of heartbeats.
 *
 * Reached only through the Worker (Durable Objects are not routable from the
 * internet), so these internal routes need no auth of their own.
 */
export class GlobePresence {
  // The whole data model. The runtime's ctx/env constructor arguments are
  // deliberately not captured: holding on to ctx.storage would be the first
  // step towards persisting something.
  #tokens = new Map();

  // Bumped whenever the published aggregate could have changed. Reads reuse
  // the last snapshot while it is unchanged, so a steady stream of heartbeats
  // costs no re-aggregation at all and a poll is never an O(n) sweep plus an
  // O(n) rollup per request (GSEC-4). Tied to membership rather than to a
  // timer, so a delete is still reflected on the very next read.
  #generation = 0;
  #snapshot = null;
  #snapshotGeneration = -1;

  // Random, in-memory, and regenerated whenever this object is re-created.
  // Source buckets are keyed through it so the map holds an unlinkable id
  // rather than anything derived from an IP address.
  #sourceSalt = crypto.randomUUID();

  async fetch(request) {
    const now = Date.now();
    // Lazy eviction: every request pays for its own share of the cleanup, so
    // no alarm (and no storage write) is ever needed.
    if (sweepExpired(this.#tokens, now) > 0) this.#generation += 1;

    const { pathname } = new URL(request.url);

    if (pathname === "/positions") {
      if (this.#snapshotGeneration !== this.#generation) {
        this.#snapshot = { points: aggregatePoints(this.#tokens), ttlSeconds: TTL_SECONDS };
        this.#snapshotGeneration = this.#generation;
      }
      return internalJson(this.#snapshot);
    }

    if (pathname === "/presence") {
      const { token, cellKey, source } = await request.json();

      if (request.method === "DELETE") {
        // Idempotent on purpose: the caller learns nothing about who was here.
        if (this.#tokens.delete(token)) this.#generation += 1;
        return internalJson({ ok: true });
      }

      const sourceId = await this.#sourceId(source);
      const previous = this.#tokens.get(token);
      const verdict = admits(this.#tokens, token, cellKey, sourceId);
      if (!verdict.ok) return internalJson({ ok: false, reason: verdict.reason }, 429);
      if (verdict.evict) this.#tokens.delete(verdict.evict);

      this.#tokens.set(token, { cellKey, sourceId, expires: now + TTL_MS });
      // A heartbeat that changes nothing but an expiry leaves the aggregate
      // alone, so it costs one Map write and nothing else.
      if (verdict.evict || previous?.cellKey !== cellKey) this.#generation += 1;
      return internalJson({ ok: true, ttlSeconds: TTL_SECONDS, heartbeatSeconds: HEARTBEAT_SECONDS });
    }

    return internalJson({ ok: false, reason: "unknown" }, 404);
  }

  /**
   * One-way, salted, truncated id for a rate-limit bucket. The bucket itself
   * (an IPv4 address or an IPv6 /64) is never stored: only this id is, and the
   * salt that produced it is random, RAM-only, and dies with the object — so
   * the per-source cap costs nothing in retained personal data.
   */
  async #sourceId(source) {
    if (typeof source !== "string" || source === "") return null;
    const bytes = new TextEncoder().encode(`${this.#sourceSalt}:${source}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

function internalJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/* ---------- Worker routes (same-origin only, no CORS) ---------- */

export const POSITIONS_PATH = "/api/globe/positions";
export const PRESENCE_PATH = "/api/globe/presence";

// Nothing but a token is ever accepted, so the body is tiny by definition.
const MAX_BODY_BYTES = 1024;

// How long the edge may serve the positions aggregate without asking the
// Durable Object again. Polls from every viewer on the planet collapse into
// one round trip per interval, which is what keeps a single global object off
// the critical path of /api/info and /api/location (GSEC-4).
export const POSITIONS_MAX_AGE = 10;

function globeHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    // Presence is per-request and ephemeral; never let anything cache it.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // No CORS headers are ever sent: the page and the API share one origin.
    // Responses still differ by Origin (see the 403 below), so key on it.
    "Vary": "Origin",
  };
}

function reply(data, status, request, extra) {
  const headers = { ...globeHeaders(), ...extra };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(data), { status, headers });
}

function methodNotAllowed(request, allow) {
  return reply({ error: "Method not allowed" }, 405, request, { Allow: allow });
}

/**
 * Read a small JSON body without trusting Content-Length: the stream is
 * abandoned as soon as it exceeds the cap, so an oversized upload cannot be
 * used to burn Worker time.
 */
async function limitedJSON(request, limit) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { error: "type" };
  }
  if (!request.body) return { error: "body" };

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { error: "body" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: "body" };
  }
}

/**
 * Rate-limit key. Residential and VPS IPv6 comes as a routed /64, so keying on
 * the full address would let one subscriber rotate through 2^64 buckets
 * (SEC-1). The bucketing is location.js's, deliberately reused rather than
 * re-derived: an open-coded `split(":").slice(0, 4)` does not expand "::", so
 * 2001:db8::1 and 2001:db8::2 would land in different buckets and the whole
 * bypass would be back (GSEC-3).
 */
export function limiterKey(ip) {
  if (typeof ip !== "string" || ip === "") return null;
  const bucket = ipBucket(ip);
  return bucket ? `globe:${bucket}` : null;
}

// Advisory only, and deliberately fail-open: a limiter outage must not take
// the feature down, because the structural caps (and server-derived
// coordinates) are what actually bound abuse here. Every method is limited,
// reads included — they reach the same single global Durable Object and pay
// the same sweep, so leaving any of them out is a free amplifier (GSEC-4).
async function withinRateLimit(request, limiter) {
  const key = limiterKey(request.headers.get("CF-Connecting-IP"));
  if (!limiter || !key) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}

async function readToken(request) {
  const body = await limitedJSON(request, MAX_BODY_BYTES);
  if (body.error === "type") return { status: 415, error: "Expected application/json" };
  if (body.error) return { status: 400, error: "Invalid or oversized JSON body" };
  // Only the token is read. There is no code path by which a client-supplied
  // coordinate could ever reach the presence map.
  const token = body.value?.token;
  if (!isUuid(token)) return { status: 400, error: "Invalid token" };
  return { token };
}

/**
 * Dispatch for /api/globe/*. Same-origin only: there is no allowlist, no
 * preflight, and no Access-Control-Allow-Origin on any response.
 */
export async function handleGlobe(request, env, url, ctx) {
  const { pathname } = url;
  if (pathname !== POSITIONS_PATH && pathname !== PRESENCE_PATH) {
    return reply({ error: "Not found" }, 404, request);
  }

  // The page is served from this same origin, so a cross-origin caller is
  // never one of ours. OPTIONS falls through to 405 for the same reason: no
  // preflight is offered because no cross-origin use is supported.
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) {
    return reply({ error: "Origin not allowed" }, 403, request);
  }

  if (!env.GLOBE) return reply({ error: "Globe presence is not configured" }, 503, request);
  const presence = () => env.GLOBE.get(env.GLOBE.idFromName("global"));

  if (pathname === POSITIONS_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(request, "GET, HEAD");
    }
    // Reads get their own, far more generous budget: a viewer polling every
    // 30 s must never be refused, but a scripted flood must not walk straight
    // into the Durable Object either.
    if (!(await withinRateLimit(request, env.GLOBE_READ_LIMITER))) {
      return reply({ error: "Too many requests" }, 429, request);
    }
    return servePositions(request, url, presence, ctx);
  }

  if (request.method !== "POST" && request.method !== "DELETE") {
    return methodNotAllowed(request, "POST, DELETE");
  }

  // Before the body is even read, and on DELETE as well as POST: both round
  // trip into the one global object, so both have to be bounded.
  if (!(await withinRateLimit(request, env.GLOBE_LIMITER))) {
    return reply({ error: "Too many requests" }, 429, request);
  }

  const parsed = await readToken(request);
  if (parsed.error) return reply({ error: parsed.error }, parsed.status, request);

  if (request.method === "DELETE") {
    await presence().fetch("https://globe.invalid/presence", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: parsed.token }),
    });
    // Always 200, even for a token that was never here: no existence oracle.
    return reply({ ok: true }, 200, request);
  }

  // The only source of coordinates, anywhere in this feature. They are snapped
  // to a ~111 km cell here and the originals are never passed on.
  const cell = snapToGrid(request.cf?.latitude, request.cf?.longitude);
  if (!cell) return reply({ error: "Location unavailable" }, 503, request);

  const upsert = await presence().fetch("https://globe.invalid/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The source bucket bounds how many pins one connection can hold. The
    // object hashes it behind a random in-memory salt and keeps only that.
    body: JSON.stringify({
      token: parsed.token,
      cellKey: cell.cellKey,
      source: limiterKey(request.headers.get("CF-Connecting-IP")),
    }),
  });
  if (upsert.status === 429) return reply({ error: "Too many requests" }, 429, request);

  return reply({ ok: true, ttlSeconds: TTL_SECONDS, heartbeatSeconds: HEARTBEAT_SECONDS }, 200, request);
}

/**
 * The positions aggregate, from the edge cache when possible.
 *
 * Everything about the entry is deliberately visitor-independent: the key is
 * the canonical URL for this origin and nothing else, and the body is the same
 * public, coarse, bucketed aggregate for every caller, so no per-visitor value
 * can enter or be read out of the cache. Cross-origin callers are turned away
 * with a 403 before they get here, and that 403 is never stored.
 */
async function servePositions(request, url, presence, ctx) {
  const cache = globalThis.caches?.default ?? null;
  const key = cache && new Request(`${url.origin}${POSITIONS_PATH}`, { method: "GET" });

  const hit = key && await cache.match(key);
  if (hit) {
    return new Response(request.method === "HEAD" ? null : hit.body, { status: 200, headers: hit.headers });
  }

  const snapshot = await (await presence().fetch("https://globe.invalid/positions")).json();
  const body = JSON.stringify(snapshot);
  const headers = { ...globeHeaders(), "Cache-Control": `public, max-age=${POSITIONS_MAX_AGE}` };

  if (key) {
    const store = cache.put(key, new Response(body, { headers }));
    if (ctx?.waitUntil) ctx.waitUntil(store);
    else await store;
  }
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
