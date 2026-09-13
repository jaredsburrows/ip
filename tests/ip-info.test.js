import assert from "node:assert/strict";
import { test } from "node:test";
import { connectingIP, countryDetails, detectIP, fetchJSON, formatCountry, formatIP, formatLocation, ipFamily } from "../ip-info.js";

test("validates complete IPv4/IPv6 addresses, including compressed and embedded IPv4", () => {
  for (const ip of ["203.0.113.1", "0.0.0.0", "255.255.255.255"]) assert.equal(ipFamily(ip), 4);
  for (const ip of ["2001:db8::1", "::1", "::", "::ffff:192.0.2.1", "2001:DB8:0:0:0:0:0:1"]) assert.equal(ipFamily(ip), 6);
  for (const ip of [null, {}, "", "1.2.3", "256.1.2.3", "01.2.3.4", "1.2.3.4 ", "hello:world", "1::2::3", "[::1]", "fe80::1%eth0"]) {
    assert.equal(ipFamily(ip), null, String(ip));
  }
});

test("connecting IP never trusts forwarding chains or synthesizes the missing family", () => {
  assert.equal(connectingIP(new Headers({ "X-Forwarded-For": "203.0.113.1" })), null);
  assert.equal(connectingIP(new Headers({ "CF-Connecting-IP": "2001:db8::1" })), "2001:db8::1");
  assert.equal(connectingIP(new Headers({ "CF-Connecting-IP": "240.1.2.3" })), null);
  assert.equal(connectingIP(new Headers({ "CF-Connecting-IP": "240.1.2.3", "CF-Connecting-IPv6": "invalid" })), null);
  assert.equal(connectingIP(new Headers({ "CF-Connecting-IP": "203.0.113.1", "CF-Connecting-IPv6": "2001:db8::1" })), "203.0.113.1");
});

test("formats country flags with readable names and skips unknown/special codes", () => {
  assert.equal(formatCountry("us"), "🇺🇸 United States (US)");
  assert.equal(formatIP("203.0.113.1", "FR"), "🇫🇷 203.0.113.1");
  for (const code of [null, "", "XX", "ZZ", "T1", "EU", "USA", "<script>", "AA"]) {
    assert.equal(countryDetails(code), null);
    assert.equal(formatIP("203.0.113.1", code), "203.0.113.1");
  }
  assert.equal(formatIP(null, "US"), null);
  assert.equal(formatLocation({ country: "US", region: "Florida", city: "Orlando" }), "🇺🇸 United States (US) → Florida → Orlando");
  assert.equal(formatLocation({ country: null, city: "Example village" }), "Example village");
  assert.equal(formatLocation({}), null);
});

test("probes separate browser endpoints and rejects a wrong-family result", async (t) => {
  const calls = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    assert.equal(options.cache, "no-store");
    return Response.json({ ip: url.includes("api6.") ? "2001:db8::1" : "203.0.113.1" });
  });
  assert.deepEqual(await Promise.all([detectIP(4), detectIP(6)]), ["203.0.113.1", "2001:db8::1"]);
  assert.deepEqual(calls, ["https://api.ipify.org?format=json", "https://api6.ipify.org?format=json"]);
  fetchMock.mock.mockImplementation(async () => Response.json({ ip: "203.0.113.1" }));
  await assert.rejects(detectIP(6), /Unexpected IP family/);
});

test("fetchJSON rejects HTTP/JSON failures and aborts stalled requests", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(fetchJSON("https://example.test"), /HTTP 503/);
  fetchMock.mock.mockImplementation(async () => new Response("invalid JSON"));
  await assert.rejects(fetchJSON("https://example.test"), SyntaxError);
  fetchMock.mock.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  await assert.rejects(fetchJSON("https://example.test", {}, 10), { name: "AbortError" });
});
