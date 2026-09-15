import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker.js";
import {
  admits,
  aggregatePoints,
  cellCentre,
  cellCount,
  countBucket,
  evictionCandidate,
  GlobePresence,
  GRID_DEGREES,
  HEARTBEAT_SECONDS,
  isUuid,
  K_ANONYMITY,
  limiterKey,
  MAX_PER_CELL,
  MAX_PER_SOURCE,
  MAX_TOKENS,
  POSITIONS_MAX_AGE,
  snapToGrid,
  sourceCount,
  sweepExpired,
  TTL_MS,
  TTL_SECONDS,
} from "../globe.js";

const presence = (entries) => new Map(entries);

// Sydney, snapped: the 1-degree row is cut into 300 columns at this latitude,
// which is what keeps the cell ~111 km wide rather than 93 km.
const SYDNEY_CELL = "-33.5:151.8";
// Its parents on the roll-up ladder: ~1,100 km, then continent-sized.
const SYDNEY_COARSE = { lat: -35, lon: 148.965517 };
const SYDNEY_CONTINENT = { lat: -20, lon: 157.5 };
// London's cell and the continent-sized cell it rolls up into.
const LONDON_CELL = "51.5:-0.803571";
const LONDON_CONTINENT = { lat: 60, lon: 0 };

// Everything the public payload is allowed to say about a count.
const BUCKETS = new Set(["1-4", "5-9", "10-24", "25-49", "50+"]);

/** `size` people in one cell, as the presence map stores them. */
function crowd(cellKey, size, prefix = "t") {
  const tokens = new Map();
  for (let i = 0; i < size; i += 1) tokens.set(`${prefix}${i}`, { cellKey, expires: 1 });
  return tokens;
}

const EARTH_CIRCUMFERENCE_KM = 40075;

/** Width in km of the cell a point falls in, measured along its parallel. */
function cellWidthKm(lat, step) {
  const centres = new Set();
  for (let lon = -180; lon < 180; lon += 0.05) centres.add(cellCentre(lat, lon, step).lon);
  return (EARTH_CIRCUMFERENCE_KM / centres.size) * Math.cos(cellCentre(lat, 0, step).lat * Math.PI / 180);
}

test("snaps Cloudflare's string coordinates to cell centres", () => {
  // request.cf hands coordinates over as strings; both forms must agree.
  assert.deepEqual(snapToGrid("-33.87", "151.21"), { lat: -33.5, lon: 151.8, cellKey: SYDNEY_CELL });
  assert.deepEqual(snapToGrid(-33.87, 151.21), { lat: -33.5, lon: 151.8, cellKey: SYDNEY_CELL });
  // Rows stay GRID_DEGREES tall, so a centre always sits half a row inside it.
  for (const { lat } of [snapToGrid(0, 0), snapToGrid(51.5, -0.12), snapToGrid("-0.1", "-0.1")]) {
    assert.equal(Math.abs(lat % GRID_DEGREES), GRID_DEGREES / 2);
  }
  // Coarsening is the whole privacy story: neighbours must collapse together.
  assert.equal(snapToGrid(51.5074, -0.1278).cellKey, snapToGrid(51.99, -0.99).cellKey);
  // ...and must not swallow the next cell over.
  assert.notEqual(snapToGrid(51.5, -0.5).cellKey, snapToGrid(52.5, -0.5).cellKey);
});

test("keeps a cell ~111 km wide at every latitude, not just at the equator", () => {
  // A fixed 1-degree longitude step gives 111 km at the equator but 38 km at
  // 70N and ~2 km at 89.5N: the smallest cells exactly where the population is
  // sparsest. Dividing the step by cos(latitude) is what fixes that (GSEC-7).
  for (const lat of [0.5, 20.5, 40.5, 60.5, 70.5, 80.5, 89.5]) {
    const width = cellWidthKm(lat, GRID_DEGREES);
    assert.ok(width > 100 && width < 125, `cell at ${lat} is ${width.toFixed(1)} km wide`);
  }
  // The number of columns falls away with the cosine, down to one circumpolar
  // cell where a whole parallel is shorter than a single cell.
  assert.equal(cellCentre(89.9, 0, 40).lon, cellCentre(89.9, 179, 40).lon, "one cell rings the pole");
  // Coarse grids keep the same property, an order of magnitude larger.
  for (const lat of [0.5, 45, 85]) {
    const width = cellWidthKm(lat, 10);
    assert.ok(width > 1000 && width < 1250, `coarse cell at ${lat} is ${width.toFixed(0)} km wide`);
  }
});

test("keeps poles and the antimeridian inside valid coordinate space", () => {
  assert.deepEqual(snapToGrid(90, 0), { lat: 89.5, lon: 0, cellKey: "89.5:0" });
  assert.deepEqual(snapToGrid(-90, 0), { lat: -89.5, lon: 0, cellKey: "-89.5:0" });
  // +180 and -180 are the same meridian and must share one cell.
  assert.equal(snapToGrid(0, 180).cellKey, snapToGrid(0, -180).cellKey);
  assert.deepEqual(snapToGrid(0, 180), { lat: 0.5, lon: -179.5, cellKey: "0.5:-179.5" });
  for (const point of [snapToGrid(90, 180), snapToGrid(-90, -180), snapToGrid(89.999, 179.999)]) {
    assert.ok(Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180, JSON.stringify(point));
  }
  // Every rung of the ladder has to stay inside the coordinate space too.
  for (const step of [1, 10, 40]) {
    for (const lat of [-90, -89.99, 0, 89.99, 90]) {
      const centre = cellCentre(lat, 179.99, step);
      assert.ok(Math.abs(centre.lat) <= 90 && Math.abs(centre.lon) <= 180, `${step}@${lat}`);
    }
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

test("counts a cell, and a source, without counting the token that is moving", () => {
  const tokens = presence([
    ["a", { cellKey: "0.5:0.5", sourceId: "aaaa", expires: 1 }],
    ["b", { cellKey: "0.5:0.5", sourceId: "bbbb", expires: 1 }],
    ["c", { cellKey: "9.5:9.5", sourceId: "aaaa", expires: 1 }],
  ]);
  assert.equal(cellCount(tokens, "0.5:0.5"), 2);
  assert.equal(cellCount(tokens, "0.5:0.5", "a"), 1);
  assert.equal(cellCount(tokens, "42.5:42.5"), 0);
  assert.equal(sourceCount(tokens, "aaaa"), 2);
  assert.equal(sourceCount(tokens, "aaaa", "c"), 1);
  assert.equal(sourceCount(tokens, "cccc"), 0);
});

test("a full map yields a slot instead of locking every newcomer out", () => {
  // GSEC-5: refusing all new tokens once MAX_TOKENS is reached hands anyone
  // with a few exit addresses a permanent denial of pins, so the fullest cell
  // gives up its stalest pin instead.
  const tokens = new Map();
  for (let i = 0; i < MAX_TOKENS; i += 1) {
    // Cell 0.5:0.5 is the fullest; "crowd-0" is its least recently refreshed.
    const crowded = i % 3 === 0;
    tokens.set(`token-${i}`, {
      cellKey: crowded ? "0.5:0.5" : `${(i % 89) + 0.5}:0.5`,
      expires: crowded ? 1000 + i : 9_000_000,
    });
  }
  assert.equal(tokens.size, MAX_TOKENS);

  const verdict = admits(tokens, "brand-new", "40.5:0.5");
  assert.equal(verdict.ok, true, "a full map must still admit someone new");
  assert.equal(verdict.evict, "token-0");
  assert.equal(tokens.get(verdict.evict).cellKey, "0.5:0.5", "the victim comes from the fullest cell");
  assert.equal(evictionCandidate(tokens), "token-0");

  // Applying the verdict keeps the map at its bound, never above it.
  tokens.delete(verdict.evict);
  tokens.set("brand-new", { cellKey: "40.5:0.5", expires: 9_000_000 });
  assert.equal(tokens.size, MAX_TOKENS);

  // A heartbeat from someone already present never evicts anyone.
  assert.deepEqual(admits(tokens, "token-1", tokens.get("token-1").cellKey), { ok: true });
});

test("enforces the per-cell cap so one cell cannot be inflated without bound", () => {
  const tokens = crowd("0.5:0.5", MAX_PER_CELL);
  assert.deepEqual(admits(tokens, "new", "0.5:0.5"), { ok: false, reason: "cell" });
  // Other cells are unaffected, and a resident re-heartbeating is fine.
  assert.deepEqual(admits(tokens, "new", "1.5:1.5"), { ok: true });
  assert.deepEqual(admits(tokens, "t0", "0.5:0.5"), { ok: true });
});

test("caps concurrent pins per source so a few hosts cannot fill the map", () => {
  const tokens = new Map();
  for (let i = 0; i < MAX_PER_SOURCE; i += 1) {
    tokens.set(`t${i}`, { cellKey: `${i + 0.5}:0.5`, sourceId: "one-source", expires: 1 });
  }
  assert.deepEqual(admits(tokens, "new", "0.5:0.5", "one-source"), { ok: false, reason: "source" });
  // A different connection is unaffected, and so is a request with no source.
  assert.deepEqual(admits(tokens, "new", "0.5:0.5", "other-source"), { ok: true });
  assert.deepEqual(admits(tokens, "new", "0.5:0.5", null), { ok: true });
  // Re-heartbeating from the same source does not consume a second slot.
  assert.deepEqual(admits(tokens, "t0", "0.5:0.5", "one-source"), { ok: true });
  // Filling MAX_TOKENS therefore takes at least this many distinct sources.
  assert.ok(MAX_TOKENS / MAX_PER_SOURCE >= 100);
});

test("publishes a count only as a bucket, never as a number", () => {
  assert.equal(countBucket(1), "1-4");
  assert.equal(countBucket(4), "1-4");
  assert.equal(countBucket(K_ANONYMITY), "5-9");
  assert.equal(countBucket(9), "5-9");
  assert.equal(countBucket(10), "10-24");
  assert.equal(countBucket(24), "10-24");
  assert.equal(countBucket(25), "25-49");
  assert.equal(countBucket(49), "25-49");
  assert.equal(countBucket(50), "50+");
  assert.equal(countBucket(5000), "50+");
  // Below one person there is nothing to describe.
  assert.equal(countBucket(0), null);
});

test("never publishes a lone visitor at city scale, or an exact head count", () => {
  // GSEC-1: the old aggregate emitted {lat, lon, count: 1} for a single
  // visitor, which is one identifiable person in one ~111 km cell.
  const solo = aggregatePoints(crowd(SYDNEY_CELL, 1));
  assert.deepEqual(solo, [{ ...SYDNEY_CONTINENT, count: "1-4" }]);
  assert.equal(solo.some((point) => point.lat === -33.5 && point.lon === 151.8), false);

  for (const size of [1, 2, 4, 5, 9, 10, 24, 25, 49, 50, 150]) {
    const points = aggregatePoints(crowd(SYDNEY_CELL, size));
    for (const point of points) {
      assert.equal(typeof point.count, "string", `${size} people produced a numeric count`);
      assert.ok(BUCKETS.has(point.count), `${size} people produced ${point.count}`);
      // Points carry coordinates and a bucket, and nothing else — ever.
      assert.deepEqual(Object.keys(point).sort(), ["count", "lat", "lon"]);
    }
    const fine = points.filter((point) => point.lat === -33.5 && point.lon === 151.8);
    if (size < K_ANONYMITY) assert.deepEqual(fine, [], `${size} people must not make a fine pin`);
    else assert.equal(fine.length, 1, `${size} people should be one fine pin`);
  }
  assert.deepEqual(aggregatePoints(new Map()), []);
});

test("rolls sub-k cells up into a coarser one instead of suppressing them", () => {
  // Suppression alone would leave the globe permanently blank at this site's
  // traffic, so three people here and two next door become one coarse pin.
  const tokens = crowd(SYDNEY_CELL, 3, "here");
  for (const [token, entry] of crowd("-34.5:150.6", 2, "near")) tokens.set(token, entry);
  assert.deepEqual(aggregatePoints(tokens), [{ ...SYDNEY_COARSE, count: "5-9" }]);

  // A cell that clears the floor on its own is published at full precision,
  // while its sparse neighbour rolls up past it to the continent.
  const mixed = crowd(SYDNEY_CELL, K_ANONYMITY, "local");
  mixed.set("stranger", { cellKey: LONDON_CELL, expires: 1 });
  assert.deepEqual(aggregatePoints(mixed), [
    { lat: -33.5, lon: 151.8, count: "5-9" },
    { ...LONDON_CONTINENT, count: "1-4" },
  ]);
});

test("aggregates every occupant exactly once, in a stable order", () => {
  const tokens = crowd("0.5:0.5", 150, "crowd");
  for (const [token, entry] of crowd(SYDNEY_CELL, 6, "syd")) tokens.set(token, entry);
  tokens.set("north", { cellKey: "89.5:0", expires: 1 });

  const points = aggregatePoints(tokens);
  assert.deepEqual(points, [
    { lat: -33.5, lon: 151.8, count: "5-9" },
    { lat: 0.5, lon: 0.5, count: "50+" },
    { lat: 85, lon: 0, count: "1-4" },
  ]);
  // Sorted by latitude then longitude, so arrival order is unobservable.
  const sorted = [...points].sort((a, b) => a.lat - b.lat || a.lon - b.lon);
  assert.deepEqual(points, sorted);
});

test("publishes cadences that are consistent with the TTL", () => {
  assert.equal(TTL_SECONDS, TTL_MS / 1000);
  // Two missed heartbeats must still be survivable, or pins would flicker.
  assert.ok(HEARTBEAT_SECONDS * 3 <= TTL_SECONDS, "TTL must outlast a couple of missed heartbeats");
  // The edge cache must expire well inside the TTL, or a removed pin could
  // outlive the presence it is meant to reflect.
  assert.ok(POSITIONS_MAX_AGE * 10 <= TTL_SECONDS);
});

/* ---------- GlobePresence Durable Object (in-memory, no storage) ---------- */

const call = (object, path, options) => object.fetch(new Request(`https://globe.invalid${path}`, options));
const upsert = (object, token, cellKey, source) =>
  call(object, "/presence", { method: "POST", body: JSON.stringify({ token, cellKey, source }) });
const drop = (object, token) =>
  call(object, "/presence", { method: "DELETE", body: JSON.stringify({ token }) });
const positions = async (object) => (await call(object, "/positions")).json();

/** Puts `size` people in one cell, one heartbeat each. */
async function fill(object, cellKey, size, prefix = "t", source) {
  for (let i = 0; i < size; i += 1) await upsert(object, `${prefix}${i}`, cellKey, source);
}

test("holds presence in memory and reports it as grid points", async () => {
  const object = new GlobePresence();
  assert.deepEqual(await positions(object), { points: [], ttlSeconds: TTL_SECONDS });

  const first = await upsert(object, "token-a", LONDON_CELL);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, ttlSeconds: TTL_SECONDS, heartbeatSeconds: HEARTBEAT_SECONDS });

  // One visitor is not a pin on their own town: they are rolled up.
  assert.deepEqual((await positions(object)).points, [{ ...LONDON_CONTINENT, count: "1-4" }]);

  // A cell only earns its own pin once K_ANONYMITY people share it.
  await fill(object, LONDON_CELL, K_ANONYMITY, "london-");
  const snapshot = await positions(object);
  assert.deepEqual(snapshot.points, [{ lat: 51.5, lon: -0.803571, count: "5-9" }]);

  // Re-heartbeating an existing token refreshes it rather than duplicating it.
  await upsert(object, "london-0", LONDON_CELL);
  assert.deepEqual((await positions(object)).points, [{ lat: 51.5, lon: -0.803571, count: "5-9" }]);
});

test("deletes are immediate, idempotent, and reveal nothing about who was there", async () => {
  const object = new GlobePresence();
  await fill(object, "0.5:0.5", K_ANONYMITY);

  const removed = await drop(object, "t0");
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  // Dropping below the floor takes the fine pin away on the very next read:
  // the cached aggregate follows membership, not a timer.
  assert.deepEqual((await positions(object)).points, [{ lat: 20, lon: 22.5, count: "1-4" }]);

  for (let i = 1; i < K_ANONYMITY; i += 1) await drop(object, `t${i}`);
  assert.deepEqual((await positions(object)).points, []);

  // Deleting an unknown token answers exactly the same way: no existence oracle.
  const unknown = await drop(object, crypto.randomUUID());
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { ok: true });
});

test("ages pins out on the TTL without an alarm or a storage write", async (t) => {
  const object = new GlobePresence();
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });

  await fill(object, "0.5:0.5", K_ANONYMITY);
  t.mock.timers.tick(TTL_MS - 1);
  assert.equal((await positions(object)).points.length, 1, "a pin survives right up to the TTL");

  t.mock.timers.tick(1);
  assert.deepEqual((await positions(object)).points, [], "and is swept the moment it expires");

  // A heartbeat inside the window extends the pin rather than re-creating it.
  await fill(object, "0.5:0.5", K_ANONYMITY, "b");
  t.mock.timers.tick(TTL_MS - 1000);
  await fill(object, "0.5:0.5", K_ANONYMITY, "b");
  t.mock.timers.tick(TTL_MS - 1000);
  assert.equal((await positions(object)).points.length, 1);
});

test("rejects writes beyond the structural caps with 429", async () => {
  const object = new GlobePresence();
  await fill(object, "0.5:0.5", MAX_PER_CELL);

  const overflow = await upsert(object, "one-too-many", "0.5:0.5");
  assert.equal(overflow.status, 429);
  assert.deepEqual(await overflow.json(), { ok: false, reason: "cell" });

  // The cap is per cell: the rest of the world is still writable, and the
  // visitors already in the full cell keep their pins.
  assert.equal((await upsert(object, "elsewhere", "10.5:10.5")).status, 200);
  assert.equal((await upsert(object, "t0", "0.5:0.5")).status, 200);
  assert.equal((await positions(object)).points.find((point) => point.lat === 0.5).count, "50+");
});

test("bounds how many pins one connection can hold at once", async () => {
  const object = new GlobePresence();
  // GSEC-5: the advisory limiter is not where the real bound lives, so the
  // per-source cap has to exist inside the object as well.
  await fill(object, "0.5:0.5", MAX_PER_SOURCE, "vpn-", "globe:203.0.113.7");

  const refused = await upsert(object, "vpn-extra", "0.5:0.5", "globe:203.0.113.7");
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { ok: false, reason: "source" });

  // Another connection is unaffected, and so is a refreshing resident.
  assert.equal((await upsert(object, "someone", "0.5:0.5", "globe:198.51.100.9")).status, 200);
  assert.equal((await upsert(object, "vpn-0", "0.5:0.5", "globe:203.0.113.7")).status, 200);
});

test("evicts the stalest pin in the fullest cell once the map is full", async () => {
  const object = new GlobePresence();
  // 20 cells of 100: enough to fill the map without tripping the per-cell cap.
  for (let i = 0; i < MAX_TOKENS; i += 1) await upsert(object, `token-${i}`, `${(i % 20) + 0.5}:0.5`);
  assert.equal((await positions(object)).points.length, 20);

  // The map is full, and a brand-new visitor still gets on the globe: before
  // GSEC-5 this was a flat 429 for everyone new, forever.
  assert.equal((await upsert(object, "newcomer", "0.5:0.5")).status, 200);
  const { points } = await positions(object);
  // A slot came out of the fullest cell rather than the map growing, so the
  // picture is unchanged: twenty cells, all still crowded.
  assert.equal(points.length, 20);
  assert.deepEqual([...new Set(points.map((point) => point.count))], ["50+"]);
});

test("never leaks anything but points from its internal routes", async () => {
  const object = new GlobePresence();
  await fill(object, LONDON_CELL, K_ANONYMITY, "x", "globe:203.0.113.7");

  const snapshot = await positions(object);
  assert.deepEqual(Object.keys(snapshot).sort(), ["points", "ttlSeconds"]);
  // No token, no expiry, no IP, no source bucket, no city — the point is the
  // entire payload.
  const body = JSON.stringify(snapshot);
  for (const leak of ["token", "source", "203.0.113.7", "expires"]) {
    assert.equal(body.includes(leak), false, leak);
  }

  const unknownRoute = await call(object, "/tokens");
  assert.equal(unknownRoute.status, 404);
  assert.deepEqual(await unknownRoute.json(), { ok: false, reason: "unknown" });
});

/* ---------- Worker routes (same-origin only, no CORS) ---------- */

const SYDNEY = { latitude: "-33.87", longitude: "151.21" };

function globeEnv(extra = {}) {
  const object = new GlobePresence();
  const counts = { positions: 0, presence: 0 };
  return {
    GLOBE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (url, init) => {
          counts[String(url).endsWith("/positions") ? "positions" : "presence"] += 1;
          return object.fetch(new Request(url, init));
        },
      }),
    },
    // Test-only bookkeeping; the Worker never reads it.
    counts,
    ...extra,
  };
}

function globeRequest(path, { cf, body, ...options } = {}) {
  const request = new Request(`https://ip.example${path}`, {
    ...options,
    ...(body === undefined ? {} : {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...options.headers },
    }),
  });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
}

const hit = (path, options, env = globeEnv()) => worker.fetch(globeRequest(path, options), env);

/** Runs `body` with a stub of the Workers edge cache in place. */
async function withEdgeCache(body) {
  const store = new Map();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "caches");
  globalThis.caches = {
    default: {
      async match(request) {
        const stored = store.get(request.url);
        return stored ? stored.clone() : undefined;
      },
      async put(request, response) {
        store.set(request.url, response.clone());
      },
    },
  };
  try {
    return await body(store);
  } finally {
    if (saved) Object.defineProperty(globalThis, "caches", saved);
    else delete globalThis.caches;
  }
}

test("publishes a pin from server-derived coordinates and reads it back", async () => {
  const env = globeEnv();
  const token = crypto.randomUUID();

  const empty = await hit("/api/globe/positions", {}, env);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { points: [], ttlSeconds: TTL_SECONDS });
  // The aggregate is public, coarse, and identical for everyone, so it is
  // cacheable on purpose — that is what keeps polls off the durable object.
  assert.equal(empty.headers.get("Cache-Control"), `public, max-age=${POSITIONS_MAX_AGE}`);
  assert.equal(empty.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(empty.headers.get("Vary"), "Origin");
  // Same-origin feature: no CORS headers are handed out, ever.
  assert.equal(empty.headers.get("Access-Control-Allow-Origin"), null);

  const published = await hit("/api/globe/presence", { method: "POST", body: { token }, cf: SYDNEY }, env);
  assert.equal(published.status, 200);
  assert.deepEqual(await published.json(), {
    ok: true, ttlSeconds: TTL_SECONDS, heartbeatSeconds: HEARTBEAT_SECONDS,
  });

  // One sharer is published as a continent, never as their own ~111 km cell.
  const filled = await (await hit("/api/globe/positions", {}, env)).json();
  assert.deepEqual(filled.points, [{ ...SYDNEY_CONTINENT, count: "1-4" }]);
});

test("ignores any coordinate the client tries to submit", async () => {
  const env = globeEnv();
  // The body carries a plausible-looking position; request.cf says Sydney.
  for (let i = 0; i < K_ANONYMITY; i += 1) {
    await hit("/api/globe/presence", {
      method: "POST",
      body: {
        token: crypto.randomUUID(), latitude: 55.75, longitude: 37.62,
        lat: 55.75, lon: 37.62, cellKey: "55.5:37.5", source: "globe:0.0.0.0",
      },
      cf: SYDNEY,
    }, env);
  }
  const { points } = await (await hit("/api/globe/positions", {}, env)).json();
  assert.deepEqual(points, [{ lat: -33.5, lon: 151.8, count: "5-9" }], "only request.cf may place a pin");
});

test("removes a pin on delete and stays silent about unknown tokens", async () => {
  const env = globeEnv();
  const token = crypto.randomUUID();
  await hit("/api/globe/presence", { method: "POST", body: { token }, cf: SYDNEY }, env);

  const removed = await hit("/api/globe/presence", { method: "DELETE", body: { token } }, env);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  assert.deepEqual((await (await hit("/api/globe/positions", {}, env)).json()).points, []);

  const stranger = await hit("/api/globe/presence", { method: "DELETE", body: { token: crypto.randomUUID() } }, env);
  assert.equal(stranger.status, 200);
  assert.deepEqual(await stranger.json(), { ok: true });
});

test("rejects bad tokens, wrong content types, and oversized bodies", async () => {
  for (const body of [{}, { token: "" }, { token: "not-a-uuid" }, { token: 7 }, { token: null }]) {
    const response = await hit("/api/globe/presence", { method: "POST", body, cf: SYDNEY });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: "Invalid token" });
  }

  const wrongType = await hit("/api/globe/presence", {
    method: "POST", body: JSON.stringify({ token: crypto.randomUUID() }),
    headers: { "Content-Type": "text/plain" }, cf: SYDNEY,
  });
  assert.equal(wrongType.status, 415);

  const notJson = await hit("/api/globe/presence", { method: "POST", body: "{", cf: SYDNEY });
  assert.equal(notJson.status, 400);

  const oversized = await hit("/api/globe/presence", {
    method: "POST", body: JSON.stringify({ token: crypto.randomUUID(), pad: "x".repeat(2048) }), cf: SYDNEY,
  });
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: "Invalid or oversized JSON body" });
});

test("reports 503 when the edge supplies no location, and never guesses one", async () => {
  const env = globeEnv();
  for (const cf of [undefined, { latitude: "", longitude: "" }, { latitude: "abc", longitude: "1" }]) {
    const response = await hit("/api/globe/presence", { method: "POST", body: { token: crypto.randomUUID() }, cf }, env);
    assert.equal(response.status, 503, JSON.stringify(cf));
    assert.deepEqual(await response.json(), { error: "Location unavailable" });
  }
  assert.deepEqual((await (await hit("/api/globe/positions", {}, env)).json()).points, []);
});

test("refuses cross-origin callers instead of answering a preflight", async () => {
  const forbidden = await hit("/api/globe/positions", { headers: { Origin: "https://evil.example" } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("Access-Control-Allow-Origin"), null);
  // A refusal is never cacheable, whatever the positions body may be.
  assert.equal(forbidden.headers.get("Cache-Control"), "no-store");

  // The retired mirror is not special-cased either.
  const mirror = await hit("/api/globe/presence", {
    method: "POST", body: { token: crypto.randomUUID() }, cf: SYDNEY,
    headers: { Origin: "https://jaredsburrows.github.io" },
  });
  assert.equal(mirror.status, 403);

  // Our own origin is fine.
  const ours = await hit("/api/globe/positions", { headers: { Origin: "https://ip.example" } });
  assert.equal(ours.status, 200);

  // No preflight is offered, because no cross-origin use is supported.
  const preflight = await hit("/api/globe/presence", { method: "OPTIONS" });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get("Allow"), "POST, DELETE");
});

test("enforces one method set per globe route and 404s the rest", async () => {
  const write = await hit("/api/globe/positions", { method: "POST", body: { token: crypto.randomUUID() } });
  assert.equal(write.status, 405);
  assert.equal(write.headers.get("Allow"), "GET, HEAD");

  const read = await hit("/api/globe/presence", { method: "PUT", body: { token: crypto.randomUUID() } });
  assert.equal(read.status, 405);
  assert.equal(read.headers.get("Allow"), "POST, DELETE");

  const head = await hit("/api/globe/positions", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const unknown = await hit("/api/globe/tokens");
  assert.equal(unknown.status, 404);
});

test("fails soft when the durable object binding is absent", async () => {
  const response = await worker.fetch(globeRequest("/api/globe/positions"), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Globe presence is not configured" });
});

test("limits every globe method, reads on their own generous budget", async () => {
  const refuse = { limit: async () => ({ success: false }) };
  const write = { method: "POST", body: { token: crypto.randomUUID() }, cf: SYDNEY,
    headers: { "CF-Connecting-IP": "203.0.113.7" } };

  assert.equal((await hit("/api/globe/presence", write, globeEnv({ GLOBE_LIMITER: refuse }))).status, 429);

  // A limiter outage must not take the feature down: the durable object caps
  // and the server-derived coordinates are the real bound.
  const broken = await hit("/api/globe/presence", write,
    globeEnv({ GLOBE_LIMITER: { limit: async () => { throw new Error("limiter down"); } } }));
  assert.equal(broken.status, 200);

  // GSEC-4: DELETE used to return before the limiter was ever consulted, and
  // reads were never limited at all — both still reach the one global object.
  const remove = { method: "DELETE", body: { token: crypto.randomUUID() },
    headers: { "CF-Connecting-IP": "203.0.113.7" } };
  assert.equal((await hit("/api/globe/presence", remove, globeEnv({ GLOBE_LIMITER: refuse }))).status, 429);

  const read = { headers: { "CF-Connecting-IP": "203.0.113.7" } };
  assert.equal((await hit("/api/globe/positions", read, globeEnv({ GLOBE_READ_LIMITER: refuse }))).status, 429);
  // Reads and writes are counted separately, so a visitor who has spent their
  // write budget can still watch the globe.
  assert.equal((await hit("/api/globe/positions", read, globeEnv({ GLOBE_LIMITER: refuse }))).status, 200);
});

test("a rejected write never reaches the durable object", async () => {
  const env = globeEnv({ GLOBE_LIMITER: { limit: async () => ({ success: false }) } });
  await hit("/api/globe/presence", {
    method: "POST", body: { token: crypto.randomUUID() }, cf: SYDNEY,
    headers: { "CF-Connecting-IP": "203.0.113.7" },
  }, env);
  assert.equal(env.counts.presence, 0, "the limiter must run before the object is touched");
});

test("serves positions from a short edge cache instead of polling the object", async () => {
  await withEdgeCache(async (store) => {
    const env = globeEnv();
    const first = await hit("/api/globe/positions", { headers: { "CF-Connecting-IP": "203.0.113.7" } }, env);
    assert.equal(first.status, 200);
    assert.equal(env.counts.positions, 1);

    // A second visitor's poll is answered from the edge: the single global
    // durable object is not touched again (GSEC-4).
    const second = await hit("/api/globe/positions", { headers: { "CF-Connecting-IP": "198.51.100.9" } }, env);
    assert.equal(second.status, 200);
    assert.equal(env.counts.positions, 1);
    assert.deepEqual(await second.json(), { points: [], ttlSeconds: TTL_SECONDS });

    // One entry for everybody: nothing about the visitor takes part in the key.
    assert.deepEqual([...store.keys()], ["https://ip.example/api/globe/positions"]);

    // HEAD is served from the same entry, still without a body.
    const head = await hit("/api/globe/positions", { method: "HEAD" }, env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(env.counts.positions, 1);

    // The stored body is the public aggregate and nothing else.
    const stored = await store.get("https://ip.example/api/globe/positions").clone().json();
    assert.deepEqual(Object.keys(stored).sort(), ["points", "ttlSeconds"]);
  });
});

test("keys the limiter per IPv6 /64, including compressed addresses", () => {
  assert.equal(limiterKey("203.0.113.7"), "globe:203.0.113.7");
  const first = limiterKey("2001:db8:1234:5678:1:2:3:4");
  assert.equal(first, "globe:2001:db8:1234:5678::/64");
  // Rotating the host half of the prefix must not buy a fresh budget.
  assert.equal(limiterKey("2001:db8:1234:5678:dead:beef:cafe:1"), first);
  // A different /64 is genuinely different.
  assert.notEqual(limiterKey("2001:db8:1234:9999::1"), first);

  // GSEC-3: an open-coded split(":").slice(0, 4) does not expand "::", so
  // these pairs used to land in different buckets despite sharing a /64.
  assert.equal(limiterKey("2001:db8::1"), limiterKey("2001:db8::2"));
  assert.equal(limiterKey("2001:db8::1"), "globe:2001:db8:0:0::/64");
  assert.equal(limiterKey("2001::1:2:3:4"), limiterKey("2001::9:8:7:6"));
  assert.equal(limiterKey("2001:db8:1234:5678::1"), first);
  // Leading zeros and case are normalised to one key as well.
  assert.equal(limiterKey("2001:0DB8:1234:5678::9"), first);
  // A /64 apart is still a different bucket after expansion.
  assert.notEqual(limiterKey("2001:db8::1"), limiterKey("2001:db8:0:1::1"));

  assert.equal(limiterKey(""), null);
  assert.equal(limiterKey(null), null);
});
