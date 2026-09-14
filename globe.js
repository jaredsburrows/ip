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
