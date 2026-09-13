import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import * as helpers from "../ip-info.js";

// Execute the actual page script with a small DOM and deterministic network /
// permission adapters. No copied application logic and no live location calls.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/import \{[^}]+\} from "\.\/ip-info\.js";/, "");

class Element {
  children = [];
  listeners = {};
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(""); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  get previousElementSibling() { return this.parent.children[this.parent.children.indexOf(this) - 1]; }
  getContext() { return null; }
}

const defaultInfo = {
  ip: "203.0.113.7", country: "US", region: "Florida", city: "Orlando",
  latitude: 0, longitude: 0, headers: {}, locationLookupAvailable: true,
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function page({ info = defaultInfo, ipv4 = "203.0.113.7", ipv6 = "2001:db8::1", city,
  origin = "https://ip.jaredsburrows.workers.dev", deferredInfo, rejectLocalInfo = false } = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element();
    element.hidden = /\bhidden\b/.test(match[0]);
    elements.set(match[1], element);
  }
  const calls = [];
  const permissions = [];
  const context = vm.createContext({
    ...helpers,
    fetchJSON: async (url, options) => {
      calls.push({ url, options });
      if (rejectLocalInfo && url === "/api/info") throw new Error("No local Worker on GitHub Pages");
      if (url.endsWith("/api/location")) {
        if (city instanceof Error) throw city;
        return city ?? { country: "FR", region: "Île-de-France", city: "Paris" };
      }
      if (deferredInfo) return deferredInfo;
      if (info instanceof Error) throw info;
      return info;
    },
    detectIP: async (family) => {
      const value = family === 4 ? ipv4 : ipv6;
      if (!value) throw new Error("unreachable");
      return value;
    },
    document: {
      getElementById: (id) => elements.get(id),
      createElement: () => new Element(),
      contentType: "text/html", characterSet: "UTF-8", referrer: "",
    },
    navigator: { language: "en-US", languages: ["en-US"], onLine: true,
      geolocation: { getCurrentPosition: (success, failure) => permissions.push({ success, failure }) },
    },
    location: { origin, href: `${origin}/`, hostname: new URL(origin).hostname },
    window: { isSecureContext: true },
    screen: {}, innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    console: { info() {} },
    XMLHttpRequest: class {
      open() {}
      send() { this.onload(); }
      getAllResponseHeaders() { return "x-z: last\r\nx-a: first"; }
    },
  });
  vm.runInContext(script, context);
  await flush();
  const el = (id) => elements.get(id);
  const row = (body, label) => el(body).children.find((tr) => tr.children[0].textContent === label)?.children[1].textContent;
  return { el, row, calls, permissions };
}

test("page starts with the Cloudflare city, independent IP families, and no permission/upload request", async () => {
  const ui = await page();
  assert.equal(ui.el("location-summary").textContent, "🇺🇸 United States (US) → Florida → Orlando");
  assert.equal(ui.row("network-body", "Public IP (Cloudflare)"), "🇺🇸 203.0.113.7");
  assert.equal(ui.row("network-body", "IPv6 Address"), "2001:db8::1");
  assert.equal(ui.row("network-body", "Coordinates (IP-based)"), "0, 0");
  assert.equal(ui.permissions.length, 0);
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.el("city-lookup").checked, false);
  assert.equal(ui.el("city-lookup-option").hidden, false);
  assert.equal(ui.el("geo-table").hidden, true);
  assert.equal(ui.el("headers-body").children[0].children[0].textContent, "x-a");
});

test("device permission alone keeps coordinates local and preserves the IP summary", async () => {
  const ui = await page();
  ui.el("geo-button").listeners.click();
  assert.equal(ui.permissions.length, 1);
  await ui.permissions[0].success({ coords: { latitude: 48.85, longitude: 2.35, accuracy: 15 } });
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.row("geo-body", "Accuracy"), "±15 m");
  assert.ok(ui.el("location-summary").textContent.includes("Orlando"));
  assert.equal(ui.el("geo-button").disabled, false);
});

test("city lookup is explicitly selected, updates device location, and keeps the IP flag independent", async () => {
  const ui = await page();
  ui.el("city-lookup").checked = true;
  ui.el("geo-button").listeners.click();
  await ui.permissions[0].success({ coords: { latitude: 48.85, longitude: 2.35, accuracy: 15 } });
  assert.equal(ui.calls[1].url, "/api/location");
  assert.equal(ui.calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(ui.calls[1].options.body), { latitude: 48.85, longitude: 2.35 });
  assert.ok(ui.el("location-summary").textContent.startsWith("🇫🇷 France"));
  assert.ok(ui.el("location-summary").textContent.endsWith("Paris"));
  assert.ok(ui.el("location-source").textContent.includes("±15 m"));
  assert.equal(ui.row("network-body", "Public IP (Cloudflare)"), "🇺🇸 203.0.113.7");
  assert.equal(ui.row("network-body", "City (IP-based)"), "Orlando");
  assert.equal(ui.el("geo-attribution").hidden, false);
  ui.el("geo-button").listeners.click();
  ui.permissions[1].failure({ code: 1 });
  assert.ok(ui.el("location-summary").textContent.includes("Orlando"));
  assert.equal(ui.row("geo-body", "Location"), "Permission denied.");
});

test("denied permission and city failures retain the fallback and leave controls usable", async () => {
  const denied = await page();
  denied.el("city-lookup").checked = true;
  denied.el("geo-button").listeners.click();
  denied.permissions[0].failure({ code: 1 });
  assert.equal(denied.calls.length, 1);
  assert.equal(denied.el("geo-button").disabled, false);
  for (const city of [new Error("offline"), { country: "FR", city: null }]) {
    const ui = await page({ city });
    ui.el("city-lookup").checked = true;
    ui.el("geo-button").listeners.click();
    await ui.permissions[0].success({ coords: { latitude: 48, longitude: 2, accuracy: 100 } });
    assert.ok(ui.el("location-summary").textContent.includes("Orlando"));
    assert.equal(ui.el("geo-button").disabled, false);
  }
});

test("failed API and IPv6 checks still show IPv4 without assigning an unverified country flag", async () => {
  const ui = await page({ info: new Error("offline"), ipv6: null });
  assert.equal(ui.row("network-body", "Public IP (ipify fallback)"), "203.0.113.7");
  assert.equal(ui.row("network-body", "IPv6 Address"), "(not detected)");
  assert.equal(ui.el("location-summary").textContent, "Location unavailable");
  assert.equal(ui.el("city-lookup-option").hidden, true);
});

test("late API results preserve completed IP probes and use the Worker address when its probe fails", async () => {
  let resolve;
  const deferredInfo = new Promise((done) => { resolve = done; });
  const ui = await page({ deferredInfo, ipv6: null });
  assert.equal(ui.row("network-body", "IPv4 Address"), "203.0.113.7");
  resolve({ ...defaultInfo, ip: "2001:db8::2" });
  await flush();
  assert.equal(ui.row("network-body", "IPv4 Address"), "203.0.113.7");
  assert.equal(ui.row("network-body", "IPv6 Address"), "🇺🇸 2001:db8::2");
});

test("missing optional bindings hide city lookup while device coordinates remain available", async () => {
  const ui = await page({ info: { ...defaultInfo, locationLookupAvailable: false } });
  assert.equal(ui.el("city-lookup-option").hidden, true);
  ui.el("geo-button").listeners.click();
  await ui.permissions[0].success({ coords: { latitude: 0, longitude: 0, accuracy: 10 } });
  assert.equal(ui.row("geo-body", "Latitude"), "0.000000");
  assert.equal(ui.calls.length, 1);
});

test("GitHub Pages falls back to the Cloudflare API and sends city lookup to that same origin", async () => {
  const ui = await page({ origin: "https://jaredsburrows.github.io", rejectLocalInfo: true });
  assert.deepEqual(ui.calls.map(({ url }) => url), ["/api/info", "https://ip.jaredsburrows.workers.dev/api/info"]);
  ui.el("city-lookup").checked = true;
  ui.el("geo-button").listeners.click();
  await ui.permissions[0].success({ coords: { latitude: 48.85, longitude: 2.35, accuracy: 15 } });
  assert.equal(ui.calls[2].url, "https://ip.jaredsburrows.workers.dev/api/location");
  assert.ok(ui.el("location-summary").textContent.includes("Paris"));
});
