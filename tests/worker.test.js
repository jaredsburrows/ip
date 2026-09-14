import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker.js";

function request(path = "/api/info", { cf, ...options } = {}) {
  const req = new Request(`https://ip.example${path}`, options);
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  return req;
}

test("echoes existing request metadata, headers, and Cloudflare geo without caching", async () => {
  const response = await worker.fetch(request("/api/info", {
    headers: { "CF-Connecting-IP": "203.0.113.7", "X-Test": "value", Origin: "https://ip.example" },
    cf: { country: "US", region: "Florida", regionCode: "FL", city: "Orlando", latitude: "28.54", longitude: "-81.38",
      httpProtocol: "HTTP/2", tlsVersion: "TLSv1.3", tlsCipher: "TLS_AES_128_GCM_SHA256", clientAcceptEncoding: "gzip, br",
      clientTcpRtt: 12, asn: 123, asOrganization: "Example", isEUCountry: "0", colo: "MIA" },
  }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Vary"), "Origin");
  // Single origin: no CORS headers are handed out, even to our own page.
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(data.ip, "203.0.113.7");
  assert.equal(data.ipVersion, 4);
  assert.equal(data.city, "Orlando");
  assert.equal(data.regionCode, "FL");
  assert.equal(data.latitude, "28.54");
  assert.equal(data.rttMs, 12);
  assert.equal(data.isEUCountry, false);
  assert.equal(data.httpProtocol, "HTTP/2");
  assert.equal(data.tlsVersion, "TLSv1.3");
  assert.equal(data.acceptEncoding, "gzip, br");
  assert.equal(data.headers["x-test"], "value");
  assert.equal(data.locationLookupAvailable, false);
});

test("preserves zero-valued metadata and recognizes Cloudflare's EU marker", async () => {
  const zero = await (await worker.fetch(request("/api/info", {
    cf: { latitude: "0", longitude: "0", clientTcpRtt: 0 },
  }))).json();
  assert.equal(zero.latitude, "0");
  assert.equal(zero.longitude, "0");
  assert.equal(zero.rttMs, 0);
  const eu = await (await worker.fetch(request("/api/info", {
    cf: { country: "FR", city: "Paris", isEUCountry: "1" },
  }))).json();
  assert.equal(eu.isEUCountry, true);
});

test("works without request.cf, keeps X-Forwarded-For diagnostic only", async () => {
  const response = await worker.fetch(request("/api/info", {
    headers: { "X-Forwarded-For": "203.0.113.99", "Accept-Encoding": "gzip", Origin: "https://ip.example" },
  }));
  const data = await response.json();
  assert.equal(data.ip, null);
  assert.equal(data.city, null);
  assert.equal(data.rttMs, null);
  assert.equal(data.acceptEncoding, "gzip");
  assert.equal(data.xForwardedFor, "203.0.113.99");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("managed header fallback is opt-in, fills gaps, and never overrides cf", async () => {
  const req = () => request("/api/info", { cf: { country: "US", city: "Orlando" }, headers: {
    "CF-IPCity": "Miami", "CF-Region": "Florida", "CF-IPCountry": "FR", "CF-IPLatitude": "0",
  } });
  const untrusted = await (await worker.fetch(req())).json();
  assert.equal(untrusted.region, null);
  const trusted = await (await worker.fetch(req(), { TRUST_LOCATION_HEADERS: "true" })).json();
  assert.equal(trusted.city, "Orlando");
  assert.equal(trusted.country, "US");
  assert.equal(trusted.region, "Florida");
  assert.equal(trusted.latitude, "0");
});

test("normalizes Pseudo IPv4 to the preserved real IPv6", async () => {
  const data = await (await worker.fetch(request("/api/info", { headers: {
    "CF-Connecting-IP": "240.1.2.3", "CF-Connecting-IPv6": "2001:db8::42",
  } }))).json();
  assert.equal(data.ip, "2001:db8::42");
  assert.equal(data.ipVersion, 6);
});

test("routing, HEAD, method rejection and cross-origin refusal", async () => {
  assert.equal((await worker.fetch(request("/api/missing"))).status, 404);
  const head = await worker.fetch(request("/api/info", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await worker.fetch(request("/api/info", { method: "POST" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, HEAD");
  // Every endpoint refuses a cross-origin browser caller and hands back no
  // Access-Control-* header it could act on.
  for (const path of ["/api/info", "/api/location"]) {
    const cross = await worker.fetch(request(path, { headers: { Origin: "https://untrusted.example" } }));
    assert.equal(cross.status, 403);
    assert.equal(cross.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(cross.headers.get("Vary"), "Origin");
  }
  // A preflight is never answered: nothing legitimate sends one any more.
  const options = await worker.fetch(request("/api/location", { method: "OPTIONS", headers: {
    Origin: "https://ip.example", "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
  } }));
  assert.equal(options.status, 405);
  assert.equal(options.headers.get("Allow"), "POST");
  assert.equal(options.headers.get("Access-Control-Allow-Methods"), null);
});

const env = (success = true) => ({ GEOAPIFY_API_KEY: "test-only-secret", LOCATION_LIMITER: {
  async limit({ key }) {
    assert.equal(key, "ip:location:203.0.113.7");
    return { success };
  },
} });
const locationRequest = (body = { latitude: 28.54, longitude: -81.38 }, headers = {}) =>
  request("/api/location", { method: "POST", headers: {
    "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7",
    Origin: "https://ip.example", ...headers,
  }, body: JSON.stringify(body) });

test("city lookup returns only locality fields and keeps secrets/coordinates out of its response", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, "https://api.geoapify.com");
    assert.equal(url.searchParams.get("apiKey"), "test-only-secret");
    assert.equal(url.searchParams.get("type"), "city");
    assert.equal(url.searchParams.get("lat"), "28.54");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return Response.json({ results: [{ country_code: "us", state: "Florida", city: "Orlando", lat: 28.54, street: "Private street" }] });
  });
  const response = await worker.fetch(locationRequest(), env());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { country: "US", region: "Florida", city: "Orlando", source: "device" });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("lookup is unavailable without both a secret and rate limiter", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Must not fetch"); });
  for (const bindings of [{}, { GEOAPIFY_API_KEY: "test" }, { LOCATION_LIMITER: env().LOCATION_LIMITER }]) {
    assert.equal((await worker.fetch(locationRequest(), bindings)).status, 503);
    const data = await (await worker.fetch(request(), bindings)).json();
    assert.equal(data.locationLookupAvailable, false);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("rejects bad coordinates, oversized bodies, wrong content type, origins and methods before upstream calls", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Must not fetch"); });
  for (const body of [null, {}, [], "hello", { latitude: "1", longitude: 2 },
    { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 },
    { latitude: 0, longitude: 0, extra: "x".repeat(1100) }]) {
    assert.equal((await worker.fetch(locationRequest(body), env())).status, 400);
  }
  assert.equal((await worker.fetch(locationRequest(undefined, { "Content-Type": "text/plain" }), env())).status, 415);
  assert.equal((await worker.fetch(locationRequest(undefined, { Origin: "https://untrusted.example" }), env())).status, 403);
  assert.equal((await worker.fetch(request("/api/location"), env())).status, 405);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("rate limiting fails closed and avoids provider calls", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Must not fetch"); });
  assert.equal((await worker.fetch(locationRequest(), env(false))).status, 429);
  const broken = env();
  broken.LOCATION_LIMITER.limit = async () => { throw new Error("unavailable"); };
  assert.equal((await worker.fetch(locationRequest(), broken)).status, 502);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("accepts zero coordinates and town/village names without inventing a nearby city", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ results: [{ country_code: "gb", village: "Example village" }] }));
  const response = await worker.fetch(locationRequest({ latitude: 0, longitude: 0 }), env());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).city, "Example village");
});

test("provider errors, malformed/oversized results and timeouts return a generic noncached error", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  for (const run of [
    async () => new Response("provider secret", { status: 429 }),
    async () => new Response("not json"),
    async () => Response.json({ results: [] }),
    async () => new Response("x".repeat(65537)),
    async () => { throw new DOMException("test-only-secret", "TimeoutError"); },
  ]) {
    fetchMock.mock.mockImplementation(run);
    const response = await worker.fetch(locationRequest(), env());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.text()).includes("test-only-secret"), false);
  }
});

test("an untrusted origin is rejected before any method handling", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Must not fetch"); });
  const response = await worker.fetch(request("/api/location", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example", "Access-Control-Request-Method": "POST" },
  }));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), null);
  assert.equal(response.headers.get("Allow"), null);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("HEAD is not an allowed method on the location endpoint", async () => {
  const response = await worker.fetch(request("/api/location", { method: "HEAD" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
});

test("a request body without any Content-Type header is rejected, not crashed on", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Must not fetch"); });
  const req = locationRequest();
  req.headers.delete("Content-Type");
  assert.equal(req.headers.get("Content-Type"), null);
  const response = await worker.fetch(req, env());
  assert.equal(response.status, 415);
  assert.equal(fetchMock.mock.callCount(), 0);
});
