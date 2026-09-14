import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admits,
  aggregatePoints,
  cellCount,
  GRID_DEGREES,
  HEARTBEAT_SECONDS,
  isUuid,
  MAX_COUNT,
  MAX_PER_CELL,
  MAX_TOKENS,
  snapToGrid,
  sweepExpired,
  TTL_MS,
  TTL_SECONDS,
} from "../globe.js";

const presence = (entries) => new Map(entries);

test("snaps Cloudflare's string coordinates to 1-degree cell centres", () => {
  // request.cf hands coordinates over as strings; both forms must agree.
  assert.deepEqual(snapToGrid("-33.87", "151.21"), { lat: -33.5, lon: 151.5, cellKey: "-33.5:151.5" });
  assert.deepEqual(snapToGrid(-33.87, 151.21), { lat: -33.5, lon: 151.5, cellKey: "-33.5:151.5" });
  // Every cell centre sits half a grid step inside its cell, never on the edge.
  for (const { lat, lon } of [snapToGrid(0, 0), snapToGrid(51.5, -0.12), snapToGrid("-0.1", "-0.1")]) {
    assert.equal(Math.abs(lat % GRID_DEGREES), GRID_DEGREES / 2);
    assert.equal(Math.abs(lon % GRID_DEGREES), GRID_DEGREES / 2);
  }
  // Coarsening is the whole privacy story: neighbours must collapse together.
  assert.equal(snapToGrid(51.5074, -0.1278).cellKey, snapToGrid(51.99, -0.99).cellKey);
  // ...and must not swallow the next cell over.
  assert.notEqual(snapToGrid(51.5, -0.5).cellKey, snapToGrid(52.5, -0.5).cellKey);
});

test("keeps poles and the antimeridian inside valid coordinate space", () => {
  assert.deepEqual(snapToGrid(90, 0), { lat: 89.5, lon: 0.5, cellKey: "89.5:0.5" });
  assert.deepEqual(snapToGrid(-90, 0), { lat: -89.5, lon: 0.5, cellKey: "-89.5:0.5" });
  // +180 and -180 are the same meridian and must share one cell.
  assert.equal(snapToGrid(0, 180).cellKey, snapToGrid(0, -180).cellKey);
  assert.deepEqual(snapToGrid(0, 180), { lat: 0.5, lon: -179.5, cellKey: "0.5:-179.5" });
  for (const point of [snapToGrid(90, 180), snapToGrid(-90, -180), snapToGrid(89.999, 179.999)]) {
    assert.ok(Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180, JSON.stringify(point));
  }
});

test("rejects missing, malformed, and out-of-range coordinates", () => {
  // `wrangler dev` and a few real edge cases deliver no geo at all.
  for (const [lat, lon] of [
    [undefined, undefined], [null, null], ["", ""], ["abc", "1"], ["1", {}],
    [NaN, 0], [Infinity, 0], [91, 0], [-91, 0], [0, 181], [0, -181], [[], []], [true, true],
  ]) {
    assert.equal(snapToGrid(lat, lon), null, `${String(lat)},${String(lon)}`);
  }
  // Zero is a real coordinate, not a missing one.
  assert.deepEqual(snapToGrid(0, "0"), { lat: 0.5, lon: 0.5, cellKey: "0.5:0.5" });
});

test("accepts only the token shape crypto.randomUUID() produces", () => {
  assert.ok(isUuid("123e4567-e89b-42d3-a456-426614174000"));
  assert.ok(isUuid(crypto.randomUUID()));
  for (const token of [
    "", "not-a-uuid", 42, null, undefined, {}, ["123e4567-e89b-42d3-a456-426614174000"],
    "123e4567-e89b-12d3-a456-426614174000", // v1: not what the client generates
    "123e4567-e89b-42d3-c456-426614174000", // bad variant nibble
    "123e4567-e89b-42d3-a456-42661417400", // too short
    " 123e4567-e89b-42d3-a456-426614174000", // no surrounding slop
    "123e4567-e89b-42d3-a456-426614174000\n",
  ]) {
    assert.equal(isUuid(token), false, JSON.stringify(token));
  }
});

test("sweeps expired entries and leaves live ones untouched", () => {
  const now = 1_700_000_000_000;
  const tokens = presence([
    ["a", { cellKey: "0.5:0.5", expires: now - 1 }],
    ["b", { cellKey: "0.5:0.5", expires: now }], // exactly due: gone
    ["c", { cellKey: "1.5:1.5", expires: now + 1 }],
    ["d", { cellKey: "1.5:1.5", expires: now + TTL_MS }],
  ]);
  assert.equal(sweepExpired(tokens, now), 2);
  assert.deepEqual([...tokens.keys()], ["c", "d"]);
  // Sweeping twice is a no-op; the DO sweeps on every request.
  assert.equal(sweepExpired(tokens, now), 0);
  // A heartbeat gap longer than the TTL cannot survive.
  assert.equal(sweepExpired(tokens, now + TTL_MS + 1), 2);
  assert.equal(tokens.size, 0);
});

test("counts a cell without counting the token that is moving out of it", () => {
  const tokens = presence([
    ["a", { cellKey: "0.5:0.5", expires: 1 }],
    ["b", { cellKey: "0.5:0.5", expires: 1 }],
    ["c", { cellKey: "9.5:9.5", expires: 1 }],
  ]);
  assert.equal(cellCount(tokens, "0.5:0.5"), 2);
  assert.equal(cellCount(tokens, "0.5:0.5", "a"), 1);
  assert.equal(cellCount(tokens, "42.5:42.5"), 0);
});

test("enforces the global token cap without evicting established visitors", () => {
  const tokens = new Map();
  for (let i = 0; i < MAX_TOKENS; i += 1) {
    tokens.set(`token-${i}`, { cellKey: `${(i % 179) + 0.5}:0.5`, expires: 1 });
  }
  assert.equal(tokens.size, MAX_TOKENS);
  assert.deepEqual(admits(tokens, "brand-new", "0.5:0.5"), { ok: false, reason: "tokens" });
  // A heartbeat from someone already present is never rejected by the cap.
  assert.deepEqual(admits(tokens, "token-0", "0.5:0.5"), { ok: true });
});

test("enforces the per-cell cap so one cell cannot be inflated without bound", () => {
  const tokens = new Map();
  for (let i = 0; i < MAX_PER_CELL; i += 1) tokens.set(`t${i}`, { cellKey: "0.5:0.5", expires: 1 });
  assert.deepEqual(admits(tokens, "new", "0.5:0.5"), { ok: false, reason: "cell" });
  // Other cells are unaffected, and a resident re-heartbeating is fine.
  assert.deepEqual(admits(tokens, "new", "1.5:1.5"), { ok: true });
  assert.deepEqual(admits(tokens, "t0", "0.5:0.5"), { ok: true });
});

test("aggregates cells into label-free points with capped counts", () => {
  const tokens = new Map([["solo", { cellKey: "-33.5:151.5", expires: 1 }]]);
  for (let i = 0; i < 150; i += 1) tokens.set(`crowd-${i}`, { cellKey: "0.5:0.5", expires: 1 });
  tokens.set("north", { cellKey: "89.5:-179.5", expires: 1 });

  const points = aggregatePoints(tokens);
  assert.deepEqual(points, [
    { lat: -33.5, lon: 151.5, count: 1 },
    { lat: 0.5, lon: 0.5, count: MAX_COUNT },
    { lat: 89.5, lon: -179.5, count: 1 },
  ]);
  // Points carry coordinates and a count, and nothing else — ever.
  for (const point of points) assert.deepEqual(Object.keys(point).sort(), ["count", "lat", "lon"]);
  assert.deepEqual(aggregatePoints(new Map()), []);
});

test("publishes cadences that are consistent with the TTL", () => {
  assert.equal(TTL_SECONDS, TTL_MS / 1000);
  // Two missed heartbeats must still be survivable, or pins would flicker.
  assert.ok(HEARTBEAT_SECONDS * 3 <= TTL_SECONDS, "TTL must outlast a couple of missed heartbeats");
});
