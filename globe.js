/*
 * Live globe presence — pure logic.
 *
 * Privacy model (see .team/PRD.md): the only per-visitor datum handled here is
 * a client-generated random token plus a grid cell derived server-side from
 * request.cf. Nothing in this module accepts, stores, or returns an IP, a user
 * agent, a precise coordinate, or any city/region/country string, so there is
 * no join key to leak. Coordinates are snapped to a 1.0-degree cell centre
 * (~111 km) before they are ever written down.
 */

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

// Displayed counts stop here so a busy cell cannot be used as a traffic meter.
export const MAX_COUNT = 99;

// Cell size in degrees. 1.0 is ~111 km at the equator and narrower towards the
// poles, which is the coarsening that makes a lone visitor unidentifiable.
export const GRID_DEGREES = 1;

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

/**
 * Snap a coordinate pair to the centre of its 1.0-degree cell.
 * Returns null when the pair is missing or out of range.
 */
export function snapToGrid(rawLat, rawLon) {
  const lat = coordinate(rawLat, 90);
  const lon = coordinate(rawLon, 180);
  if (lat === null || lon === null) return null;

  // The top row would otherwise centre at 90.5, outside the valid range.
  let row = Math.floor(lat / GRID_DEGREES);
  if (row * GRID_DEGREES >= 90) row -= 1;

  // +180 and -180 are the same meridian, so they must share one cell.
  let column = Math.floor(lon / GRID_DEGREES);
  if (column * GRID_DEGREES >= 180) column = -180 / GRID_DEGREES;

  const centre = (index) => round(index * GRID_DEGREES + GRID_DEGREES / 2);
  const snapped = { lat: centre(row), lon: centre(column) };
  return { ...snapped, cellKey: `${snapped.lat}:${snapped.lon}` };
}

// Keeps cell centres exact (0.1-degree grids would otherwise drift in binary).
function round(value) {
  return Math.round(value * 1e6) / 1e6;
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

/**
 * Cap check for a write. Heartbeats from a known token never consume new
 * capacity, so an established visitor cannot be pushed out by a flood.
 */
export function admits(tokens, token, cellKey) {
  if (!tokens.has(token) && tokens.size >= MAX_TOKENS) return { ok: false, reason: "tokens" };
  if (cellCount(tokens, cellKey, token) >= MAX_PER_CELL) return { ok: false, reason: "cell" };
  return { ok: true };
}

/**
 * Collapse the presence map into the public payload: one label-free point per
 * occupied cell, counts capped, ordered deterministically so the response body
 * carries no information about arrival order.
 */
export function aggregatePoints(tokens) {
  const counts = new Map();
  for (const entry of tokens.values()) {
    counts.set(entry.cellKey, (counts.get(entry.cellKey) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([cellKey, count]) => {
      const [lat, lon] = cellKey.split(":");
      return { lat: Number(lat), lon: Number(lon), count: Math.min(count, MAX_COUNT) };
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

  async fetch(request) {
    const now = Date.now();
    // Lazy eviction: every request pays for its own share of the cleanup, so
    // no alarm (and no storage write) is ever needed.
    sweepExpired(this.#tokens, now);

    const { pathname } = new URL(request.url);

    if (pathname === "/positions") {
      return internalJson({ points: aggregatePoints(this.#tokens), ttlSeconds: TTL_SECONDS });
    }

    if (pathname === "/presence") {
      const { token, cellKey } = await request.json();

      if (request.method === "DELETE") {
        // Idempotent on purpose: the caller learns nothing about who was here.
        this.#tokens.delete(token);
        return internalJson({ ok: true });
      }

      const verdict = admits(this.#tokens, token, cellKey);
      if (!verdict.ok) return internalJson({ ok: false, reason: verdict.reason }, 429);

      this.#tokens.set(token, { cellKey, expires: now + TTL_MS });
      return internalJson({ ok: true, ttlSeconds: TTL_SECONDS, heartbeatSeconds: HEARTBEAT_SECONDS });
    }

    return internalJson({ ok: false, reason: "unknown" }, 404);
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
 * (SEC-1). Collapsing to the /64 removes the cheapest bypass; it is still only
 * a courtesy control, and the caps in the Durable Object are the real bound.
 */
export function limiterKey(ip) {
  if (typeof ip !== "string" || ip === "") return null;
  if (!ip.includes(":")) return `globe:${ip}`;
  const hextets = ip.split(":");
  // An abbreviated address ("2001:db8::1") has fewer than four leading
  // hextets only when the elision starts inside the /64, so the prefix is
  // whatever precedes it — expanding it would add no entropy.
  return `globe:${hextets.slice(0, 4).join(":")}::/64`;
}

// Advisory only, and deliberately fail-open: a limiter outage must not take
// the feature down, because the structural caps (and server-derived
// coordinates) are what actually bound abuse here.
async function withinRateLimit(request, env) {
  const key = limiterKey(request.headers.get("CF-Connecting-IP"));
  if (!env.GLOBE_LIMITER || !key) return true;
  try {
    const { success } = await env.GLOBE_LIMITER.limit({ key });
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
export async function handleGlobe(request, env, url) {
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
  const presence = env.GLOBE.get(env.GLOBE.idFromName("global"));

  if (pathname === POSITIONS_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(request, "GET, HEAD");
    }
    const snapshot = await (await presence.fetch("https://globe.invalid/positions")).json();
    return reply(snapshot, 200, request);
  }

  if (request.method !== "POST" && request.method !== "DELETE") {
    return methodNotAllowed(request, "POST, DELETE");
  }

  const parsed = await readToken(request);
  if (parsed.error) return reply({ error: parsed.error }, parsed.status, request);

  if (request.method === "DELETE") {
    await presence.fetch("https://globe.invalid/presence", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: parsed.token }),
    });
    // Always 200, even for a token that was never here: no existence oracle.
    return reply({ ok: true }, 200, request);
  }

  if (!(await withinRateLimit(request, env))) {
    return reply({ error: "Too many requests" }, 429, request);
  }

  // The only source of coordinates, anywhere in this feature. They are snapped
  // to a ~111 km cell here and the originals are never passed on.
  const cell = snapToGrid(request.cf?.latitude, request.cf?.longitude);
  if (!cell) return reply({ error: "Location unavailable" }, 503, request);

  const upsert = await presence.fetch("https://globe.invalid/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: parsed.token, cellKey: cell.cellKey }),
  });
  if (upsert.status === 429) return reply({ error: "Too many requests" }, 429, request);

  return reply({ ok: true, ttlSeconds: TTL_SECONDS, heartbeatSeconds: HEARTBEAT_SECONDS }, 200, request);
}
