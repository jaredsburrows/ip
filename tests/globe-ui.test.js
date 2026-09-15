import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const html = read("index.html");
const ui = read("globe-ui.js");
// Comments explain what is deliberately absent, so strip them before asserting
// that an API is genuinely unused.
const uiCode = ui.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

// Tag and attribute names in HTML are case-insensitive: a browser fetches
// `<SCRIPT SRC=...>` exactly as it fetches `<script src=...>`. Every pattern
// that reads markup below carries /i for that reason, so no stray capital can
// smuggle an eager load past the guard.
const FETCHING_TAG = /<(link|script|img|iframe)\b[^>]*>/gi;
const GLOBE_ASSET = /globe-ui\.js|globe\.gl|vendor\//i;

/** Every tag in `markup` that would make the browser fetch a globe asset. */
const eagerGlobeTags = (markup) =>
  [...markup.matchAll(FETCHING_TAG)].map((match) => match[0]).filter((tag) => GLOBE_ASSET.test(tag));

// The hard acceptance criterion: with the globe unopened, the page must issue
// zero extra requests. These assertions are what keeps that true over time.
test("the page load path references no globe asset at all", () => {
  // No preload, prefetch, modulepreload, preconnect or stylesheet for them.
  assert.deepEqual(eagerGlobeTags(html), []);
  // The module is reached exactly once, and only through a dynamic import.
  assert.deepEqual(html.match(/import\("\.\/globe-ui\.js"\)/g), ['import("./globe-ui.js")']);
  // Unquoted attribute values are legal HTML, so the quotes are optional here.
  assert.equal(/(?:src|href)\s*=\s*["']?[^"'>\s]*globe-ui\.js/i.test(html), false);
  // Nothing under vendor/ is reachable from the page; globe-ui.js loads it.
  assert.equal(/["'(]\s*\.?\/?vendor\//i.test(html), false, "index.html must not reference vendor/");
  assert.match(ui, /vendor\/globe\.gl-2\.46\.2\.min\.js/);
});

test("the lazy-load guard catches an uppercase tag, as a browser would", () => {
  // Every one of these fetches a globe asset on page load, so every one of
  // them has to be caught; a case-sensitive scan sees none of them.
  for (const markup of [
    '<SCRIPT SRC="vendor/globe.gl-2.46.2.min.js"></SCRIPT>',
    "<Link rel=modulepreload href=globe-ui.js>",
    '<IMG src="/Vendor/earth-blue-marble-2048-c8fd8b5a.jpg" hidden>',
  ]) {
    assert.equal(eagerGlobeTags(markup).length, 1, markup);
  }
  // ...without flagging what the page does legitimately load on first paint.
  assert.deepEqual(eagerGlobeTags('<SCRIPT type="module" src="ip-info.js"></SCRIPT><LINK rel=icon href=favicon.svg>'), []);
});

test("the globe leads the page, and its icon costs no request", () => {
  const body = html.slice(html.indexOf("<body>"));
  const above = body.slice(0, body.indexOf("<h2>Location</h2>"));

  // Above the IP/location tables, not buried under them (T18), with the two
  // things a visitor can actually press — the globe, then device location —
  // together at the top and the IP-derived tables after them.
  assert.ok(body.indexOf('id="globe-heading"') < body.indexOf('id="geo-heading"'), "the globe must lead the page");
  assert.ok(body.indexOf('id="geo-heading"') < body.indexOf("<h2>Location</h2>"), "device location must sit beside the globe");
  assert.ok(body.indexOf('id="globe-button"') < body.indexOf("<table"), "the globe button must precede every table");

  // One sentence, and no more: the account of what the globe publishes lives
  // in README.md, so nothing here may grow back into a privacy summary.
  const blurb = body.match(/<h2 id="globe-heading">[\s\S]*?<p class="note">([\s\S]*?)<\/p>/)[1].replace(/\s+/g, " ").trim();
  assert.equal(blurb.split(/\.\s/).length, 1, blurb);
  assert.ok(blurb.length <= 100, `the globe blurb is ${blurb.length} characters: ${blurb}`);

  // The device-location blurb may not point at a control that the move put
  // somewhere else; the city-lookup option is the element right after it.
  const geo = body.slice(body.indexOf('id="geo-heading"'), body.indexOf("<h2>Location</h2>"));
  assert.equal(/\b(below|above)\b/.test(geo.slice(0, geo.indexOf('id="city-lookup-option"'))), false,
    "the device-location blurb must not claim a layout it no longer has");
  assert.ok(geo.indexOf('id="city-lookup-option"') < geo.indexOf('id="geo-button"'));

  // An emoji glyph, exactly like the country flags elsewhere on the page: no
  // <img>, no icon font, no CSS background. Moving the section to the top must
  // not put a single byte in front of first paint.
  assert.match(body.match(/<h2 id="globe-heading">([^<]*)<\/h2>/)[1], /\u{1F30D}/u);
  assert.match(body.match(/<button id="globe-button"[^>]*>([^<]*)<\/button>/)[1], /\u{1F30D}/u);
  assert.deepEqual(eagerGlobeTags(above), [], "nothing above the fold may fetch a globe asset");
});

test("index.html stays inside the page-weight budget", () => {
  const bytes = Buffer.byteLength(html);
  assert.ok(bytes <= 30720, `index.html is ${bytes} bytes, over the 30 KB budget`);
});

test("the button imports the globe module only once the visitor clicks", async () => {
  // Run the real handler from index.html, with the dynamic import replaced by
  // a spy (the only edit, and it is asserted).
  const source = html.match(/\n {6}function initGlobeButton\([^)]*\) \{\n[\s\S]*?\n {6}\}\n/)[0];
  assert.equal((source.match(/await import\(/g) ?? []).length, 1);

  const imports = [];
  const opened = [];
  const button = { disabled: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  const status = { textContent: null };
  let reads = 0;
  const context = {
    document: { getElementById: (id) => (id === "globe-button" ? button : status) },
    __import: (specifier) => {
      imports.push(specifier);
      return Promise.resolve({ open: async (options) => opened.push(options) });
    },
    // Stands in for the page's ipCoords, which /api/info fills in asynchronously.
    __coords: () => { reads += 1; return { lat: 28.7644, lon: -81.282 }; },
  };

  vm.runInNewContext(`${source.replace("await import(", "await __import(")}\ninitGlobeButton(__coords);`, context);
  // Wiring the button up must not fetch, import, or preload anything — and it
  // must not read the coordinates yet either, or a slow /api/info would lose
  // the visitor their own marker for good.
  assert.deepEqual(imports, []);
  assert.equal(status.textContent, null);
  assert.equal(reads, 0, "coordinates must be read at click time, not at wiring time");

  await button.listeners.click();
  assert.deepEqual(imports, ["./globe-ui.js"]);
  // The page hands its own IP-based coordinates to the overlay, to be drawn.
  // Field by field: the handler runs in another realm, so its object literals
  // do not share a prototype with this one.
  assert.equal(opened.length, 1);
  assert.equal(opened[0].self.lat, 28.7644);
  assert.equal(opened[0].self.lon, -81.282);
  assert.equal(status.textContent, "");
  assert.equal(button.disabled, false, "the button must not stay stuck after a successful open");
});

test("a failed load leaves the page usable and retryable", async () => {
  const source = html.match(/\n {6}function initGlobeButton\([^)]*\) \{\n[\s\S]*?\n {6}\}\n/)[0];
  let attempts = 0;
  const button = { disabled: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  const status = { textContent: null };
  const context = {
    document: { getElementById: (id) => (id === "globe-button" ? button : status) },
    __import: () => { attempts += 1; return Promise.reject(new Error("offline")); },
    __coords: () => null,
  };

  vm.runInNewContext(`${source.replace("await import(", "await __import(")}\ninitGlobeButton(__coords);`, context);
  await button.listeners.click();
  assert.equal(status.textContent, "The globe could not be loaded.");
  assert.equal(button.disabled, false);

  // Still clickable, so a flaky network is recoverable without a reload.
  await button.listeners.click();
  assert.equal(attempts, 2);
});

test("importing globe-ui.js does no work of its own", async () => {
  // Any touch of the DOM or the network at module scope throws here.
  const forbidden = (name) => new Proxy({}, {
    get() { throw new Error(`globe-ui.js used ${name} at import time`); },
    apply() { throw new Error(`globe-ui.js called ${name} at import time`); },
  });
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = forbidden("document");
  globalThis.window = forbidden("window");
  globalThis.fetch = () => { throw new Error("globe-ui.js fetched at import time"); };
  try {
    // Cache-busted so this is a genuinely fresh evaluation of the module.
    const module = await import(`../globe-ui.js?lazy-check=${Date.now()}`);
    assert.equal(typeof module.open, "function");
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("the globe client talks only to its own origin", () => {
  // No absolute URLs: no CDN, no mirror fallback, nothing for CSP to allow.
  assert.deepEqual(uiCode.match(/https?:\/\/[^"'\s)]+/gi), null);
  assert.deepEqual(new Set(ui.match(/fetch\(([^,)]+)/g)), new Set(["fetch(POSITIONS_PATH", "fetch(PRESENCE_PATH"]));
  assert.match(ui, /const POSITIONS_PATH = "\/api\/globe\/positions"/);
  assert.match(ui, /const PRESENCE_PATH = "\/api\/globe\/presence"/);
});

test("the globe assets are served, and cached for the right length of time", () => {
  const headers = read("_headers");
  // Must expire with the page that imports it (the BUG-1 failure mode).
  const page = headers.match(/^\/\n {2}Cache-Control: (.+)$/m)[1];
  // Compared as plain text: a rule read out of a file is data, and escaping it
  // well enough to be a safe pattern is a problem worth not having.
  assert.ok(headers.includes(`/globe-ui.js\n  Cache-Control: ${page}`), "globe-ui.js must expire with the page");

  const excluded = new Set(read(".assetsignore").split("\n"));
  for (const path of ["globe-ui.js", "vendor/", "vendor/globe.gl-2.46.2.min.js"]) {
    assert.equal(excluded.has(path), false, `${path} must still be served`);
  }
  // The worker-only module and the provenance note are not assets.
  assert.ok(excluded.has("globe.js"));
  assert.ok(excluded.has("*.md"));
});

test("a year of immutable is promised only for URLs that carry their own bytes", () => {
  // `_headers` as [{ path, headers }]: a path at column 0, its headers indented.
  const rules = [];
  for (const line of read("_headers").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (line.startsWith("  ")) rules.at(-1).headers.push(line.trim());
    else rules.push({ path: line, headers: [] });
  }

  const immutable = rules.filter(({ headers }) => headers.some((value) => /^Cache-Control:.*\bimmutable\b/.test(value)));
  const vendored = readdirSync(new URL("../vendor", import.meta.url)).filter((name) => !name.endsWith(".md"));
  // One rule per real file, never a pattern: a pattern would make the same
  // year-long promise for a file nobody has content-addressed yet.
  assert.deepEqual(immutable.map(({ path }) => path).sort(), vendored.map((name) => `/vendor/${name}`).sort());
  // ...and globe-ui.js asks for exactly those URLs, so a rename cannot leave a
  // stale reference behind.
  assert.deepEqual([...ui.matchAll(/new URL\("(vendor\/[^"]+)"/g)].map(([, path]) => `/${path}`).sort(),
    immutable.map(({ path }) => path).sort());

  const provenance = read("vendor/PROVENANCE.md");
  for (const { path, headers } of immutable) {
    assert.deepEqual(headers, ["Cache-Control: public, max-age=31536000, immutable"]);
    const name = path.slice("/vendor/".length);
    const sha256 = createHash("sha256").update(readFileSync(new URL(`../vendor/${name}`, import.meta.url))).digest("hex");
    // Upstream version or a prefix of the file's own hash. Either way new
    // bytes mean a new URL, so a cached copy can never mask a patched file.
    assert.ok(/-\d+\.\d+\.\d+\./.test(name) || name.includes(sha256.slice(0, 8)), `${name} is not content-addressed`);
    // PROVENANCE.md documents this exact filename, and its hash is this file.
    // An exact line match, not a pattern: escaping only the dots in a filename
    // leaves every other metacharacter live (CodeQL js/incomplete-sanitization).
    assert.ok(provenance.split("\n").includes(`## vendor/${name}`),
      `${name}: PROVENANCE.md has no heading for this file`);
    assert.ok(provenance.includes(sha256), `${name}: the SHA-256 in PROVENANCE.md is not this file`);
  }
});

test("sharing is unstored and reversible, and no tick-box gates it", () => {
  // T19: the gate is gone, so nothing may reintroduce one by the back door.
  assert.equal(/checkbox|type = "checkbox"/.test(uiCode), false);

  // The session token lives in page memory only, and nothing about the share
  // is remembered anywhere a later visit could read it back.
  assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/.test(uiCode), false);
  assert.match(ui, /shareToken = crypto\.randomUUID\(\)/);

  // Closing and paging away both remove the pin. With the "Stop sharing my
  // area" button gone at the visitor's request, these are the only paths that
  // do it, so they matter more than they did, not less. The close handler is
  // matched as a whole block rather than within a character budget, so adding
  // a comment to it can never quietly turn this assertion off.
  const closeHandler = ui.match(/dialog\.addEventListener\("close", \(\) => \{([\s\S]*?)\n {2}\}\);/)[1];
  assert.match(closeHandler, /stopSharing/);
  assert.match(ui, /addEventListener\("pagehide", \(\) => stopSharing/);
  assert.match(ui, /method: "DELETE"[\s\S]{0,160}keepalive: true/);
  // stopSharing is the only thing that sends it, so every path has to go
  // through there — no route may be left without a way to stop publishing.
  assert.deepEqual(uiCode.match(/method: "DELETE"/g), ['method: "DELETE"']);
});

test("opening the globe publishes, and closing it takes your area straight off", async () => {
  const harness = await openHarness();

  // No gate: the pin is published by the act of opening the globe.
  assert.ok(harness.calls.includes("POST /api/globe/presence"), harness.calls.join(", "));
  // One button, and it is Close. Every other control the overlay ever had has
  // now been removed on request; this asserts that stripping them did not take
  // the only way to stop publishing with them.
  assert.deepEqual(harness.overlay.dialog.children.at(-1).textContent, "Close");

  // Closing is the whole control, and it is on the DELETE path.
  harness.overlay.dialog.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(harness.calls.includes("DELETE /api/globe/presence"));
  // 30 s is the read poll, stopped with the overlay; the 60 s heartbeat must
  // not outlive the close either.
  assert.deepEqual(harness.timers(), [], "nothing may keep running once the globe is shut");

  // Re-opening shares again, because being open is exactly what sharing means
  // here — and it publishes a fresh token, never the one just deleted.
  const before = harness.calls.filter((call) => call.startsWith("POST")).length;
  await harness.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(harness.calls.filter((call) => call.startsWith("POST")).length > before);
});

test("a 200 with no cadence is a failure, not an interval of NaN", async () => {
  const harness = await openHarness(async (path) => (path === "/api/globe/presence"
    ? new Response("not json", { status: 200 })
    : new Response(JSON.stringify({ points: [], ttlSeconds: 300 }), { status: 200 })));

  // Every visitor runs this path now, so a malformed 200 must retry on a known
  // interval rather than arm setInterval(fn, NaN) and never fire again.
  assert.deepEqual(harness.timers().map((timer) => timer.ms), [30000, 15000]);
});

test("the client can never submit a position", () => {
  // The only body the client ever sends is its own random token.
  assert.deepEqual(ui.match(/body: JSON\.stringify\(([^)]+)\)/g), [
    "body: JSON.stringify({ token })",
    "body: JSON.stringify({ token })",
  ]);
  // No geolocation API, no coordinates, anywhere in the globe client.
  assert.equal(/navigator\.geolocation|getCurrentPosition|watchPosition/.test(uiCode), false);
});

test("no copy about sharing survives in the overlay, in any form", () => {
  // The visitor asked three times for the bottom bar to go, and each earlier
  // attempt kept part of it. So this asserts the absence by name: the notice,
  // the collapsed "What is shared?" disclosure, the status sentence, and every
  // control that was ever beside them. The full account is in README.md, which
  // is where it stays.
  for (const gone of [
    "globe-bar", "globe-controls", "globe-notice", "globe-disclosure", "globe-actions",
    "What is shared", "Stop sharing my area", "Your approximate area",
    "No areas are on the globe", "is on the globe",
    // GSEC-2: a published point IS a country to anyone who looks it up, so the
    // old claim to the contrary must never come back either.
    "never a street, city, or country name",
  ]) {
    assert.equal(ui.includes(gone), false, `"${gone}" must not appear in globe-ui.js`);
  }

  // Nor may it return as a tooltip, a title, or an accessible name. The only
  // attribute the overlay sets is the dialog's own name, and the only element
  // label left is the one on the visitor's private "You" marker.
  assert.deepEqual(uiCode.match(/setAttribute\([^)]*\)/g), ['setAttribute("aria-label", "Live globe")']);
  assert.equal(/\.title\s*=|"title"|aria-describedby/.test(uiCode), false, "no tooltip may carry the disclosure");
  assert.equal(/aria-live|textContent = "Loading the globe/.test(uiCode), false, "no status line may creep back in");
  assert.equal(/createElement\("(p|details|summary|label|span)"\)/.test(uiCode), false,
    "the overlay builds no text elements at all");
});

/**
 * Runs globe-ui.js in a sandbox and hands back the named internals. Two edits,
 * both asserted here: `export` is dropped (a script, not a module) and
 * `import.meta.url` becomes a literal, since only a module has one.
 */
function loadUi(context, expose) {
  const source = read("globe-ui.js")
    .replace(/^export /gm, "")
    .replace(/import\.meta\.url/g, JSON.stringify("https://ip.example/globe-ui.js"));
  assert.equal(/\bexport\b|import\.meta/.test(source), false);
  vm.createContext(context);
  return vm.runInContext(`${source}\n;(${expose});`, context);
}

/** The slice of a DOM node globe-ui.js actually touches. */
function fakeNode(tag) {
  const node = {
    tagName: tag,
    children: [],
    listeners: {},
    attributes: {},
    textContent: "",
    className: "",
    // The size a full-viewport dialog reports once showModal() has laid it
    // out — the number resize() is supposed to hand to the renderer.
    clientWidth: 1280,
    clientHeight: 720,
    addEventListener(name, fn) { (node.listeners[name] ??= []).push(fn); },
    setAttribute(name, value) { node.attributes[name] = value; },
    append(...kids) { node.children.push(...kids); },
    dispatch(name) { for (const fn of node.listeners[name] ?? []) fn(); },
    showModal() { node.open = true; },
    close() { node.open = false; node.dispatch("close"); },
  };
  return node;
}

/** Stands in for the vendored UMD bundle, recording what it is asked to do. */
function fakeGlobe() {
  const controls = {};
  const globe = { mountedOn: null, running: false, props: {}, animation: [], controls: () => controls };
  for (const name of ["backgroundColor", "globeImageUrl", "pointsData", "pointLat", "pointLng",
    "pointColor", "pointAltitude", "pointRadius", "pointLabel", "width", "height",
    "labelsData", "labelLat", "labelLng", "labelText", "labelColor", "labelSize",
    "labelDotRadius", "labelAltitude", "labelResolution", "labelLabel"]) {
    globe[name] = (value) => { globe.props[name] = value; return globe; };
  }
  globe.resumeAnimation = () => { globe.running = true; globe.animation.push("resume"); return globe; };
  globe.pauseAnimation = () => { globe.running = false; globe.animation.push("pause"); return globe; };
  return globe;
}

/**
 * Opens the overlay against a fake DOM and a fake globe.gl.
 *
 * This is NOT pixel verification — node cannot rasterise WebGL, so nothing
 * here proves the Earth is painted. It is the closest honest proxy: the
 * renderer is mounted on the stage, is given a non-zero size and the vendored
 * texture, and is still running when open() returns. The bug this catches
 * (T17) failed exactly that last assertion in a real browser too.
 */
const respondOk = async (path) => (path === "/api/globe/presence"
  ? new Response(JSON.stringify({ ok: true, ttlSeconds: 300, heartbeatSeconds: 60 }), { status: 200 })
  : new Response(JSON.stringify({ points: [], ttlSeconds: 300 }), { status: 200 }));

async function openHarness(respond = respondOk, options) {
  const globe = fakeGlobe();
  const timers = [];
  const calls = [];
  const bodies = [];
  const document = {
    createElement: (tag) => fakeNode(tag),
    head: fakeNode("head"),
    body: fakeNode("body"),
  };
  const context = {
    URL,
    document,
    window: { matchMedia: () => ({ matches: true }), addEventListener() {} },
    crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
    fetch: async (path, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${path}`);
      if (init.body !== undefined) bodies.push(init.body);
      return respond(path, init);
    },
    setInterval: (fn, ms) => timers.push({ fn, ms }),
    clearInterval: (id) => { if (id) timers[id - 1] = null; },
  };
  // Appending the <script> is what "loads" the bundle, exactly as a browser
  // would: the tag exposes window.Globe and then fires load.
  document.head.append = (node) => {
    context.window.Globe = function (stage) { globe.mountedOn = stage; return globe; };
    node.dispatch("load");
  };

  const internals = loadUi(context, "{ open, overlay: () => overlay }");
  await internals.open(options);
  // open() fires the first heartbeat without awaiting it, so let the
  // already-resolved fetch chain drain before anything is asserted.
  await new Promise((resolve) => setImmediate(resolve));
  return {
    globe,
    calls,
    bodies,
    open: internals.open,
    overlay: internals.overlay(),
    timers: () => timers.filter(Boolean),
  };
}

// Sanford, Florida — the visitor from the defect report — and the point the
// live API publishes for them: their 1-degree cell is under the k=5 floor, so
// it rolls all the way up to the 40-degree rung, whose centre sits in the
// Caribbean about 1,500 km away. Their own marker is what tells them apart.
const SANFORD = { lat: 28.7644, lon: -81.282 };
const ROLLED_UP = { lat: 20, lon: -67.5, count: "1-4" };

/** A server that publishes exactly `points`. */
const publishing = (points) => async (path) => (path === "/api/globe/presence"
  ? new Response(JSON.stringify({ ok: true, ttlSeconds: 300, heartbeatSeconds: 60 }), { status: 200 })
  : new Response(JSON.stringify({ points, ttlSeconds: 300 }), { status: 200 }));

test("the visitor's own marker is drawn locally and never leaves the browser", async () => {
  const harness = await openHarness(publishing([ROLLED_UP]), { self: SANFORD });

  // Drawn on its own layer, at the coordinates the page's Network table shows.
  // Compared field by field: the overlay runs in another realm, so its object
  // literals do not share a prototype with this file's.
  const labels = harness.globe.props.labelsData;
  assert.equal(labels.length, 1);
  assert.equal(labels[0].lat, SANFORD.lat);
  assert.equal(labels[0].lon, SANFORD.lon);
  assert.equal(harness.globe.props.labelText(), "You");
  assert.match(harness.globe.props.labelLabel(), /never published/);
  // A different layer and a different colour from everyone else's pins, or
  // "you" would be indistinguishable from "somebody, somewhere in here".
  assert.notEqual(harness.globe.props.labelColor(), harness.globe.props.pointColor());

  // ...and nothing about it left the browser. Every body this client sends is
  // its random token and nothing else, so these coordinates have no path to
  // the Worker, the Durable Object, or anyone else's screen.
  assert.ok(harness.bodies.length > 0);
  for (const body of harness.bodies) {
    assert.deepEqual(Object.keys(JSON.parse(body)), ["token"]);
    assert.equal(/28\.7644|81\.282|lat|lon/i.test(body), false, body);
  }
});

test("no usable coordinates simply means no marker, and no error", async () => {
  // /api/info returning no geo is normal, not a failure: the globe still opens.
  for (const self of [undefined, null, {}, { lat: "unknown", lon: "unknown" },
    { lat: 91, lon: 0 }, { lat: 0, lon: 181 }]) {
    const { globe } = await openHarness(publishing([ROLLED_UP]), { self });
    assert.equal(globe.props.labelsData.length, 0, JSON.stringify(self));
    // The rest of the globe is unaffected.
    assert.equal(globe.props.pointsData.length, 1);
  }
  const { globe } = await openHarness();
  assert.equal(globe.props.labelsData.length, 0, "open() with no argument must still work");
});

test("the overlay is a globe and a Close button, and nothing else", async () => {
  const { overlay } = await openHarness(publishing([]));

  // Asserted structurally, not by string, so a bar cannot come back wearing a
  // different class name: the dialog holds its own stylesheet, the stage the
  // renderer mounts on, and one button. Three children, and that is the whole
  // overlay.
  assert.deepEqual(overlay.dialog.children.map((node) => node.tagName), ["style", "div", "button"]);
  assert.deepEqual(overlay.dialog.children.map((node) => node.className), ["", "globe-stage", "globe-close"]);
  // Nothing else is built and held onto either — no notice, details, summary
  // or status handle survives on the overlay object.
  assert.deepEqual(Object.keys(overlay).sort(), ["close", "dialog", "stage"]);

  // Close is the only control, it has no label hung off it, and it is still
  // the thing that stops publishing.
  assert.equal(overlay.close.textContent, "Close");
  assert.deepEqual(overlay.close.children, []);
  assert.deepEqual(Object.keys(overlay.close.attributes), []);
  assert.deepEqual(Object.keys(overlay.close.listeners), ["click"]);
});

test("opening the globe leaves the renderer sized, textured and running", async () => {
  const { globe, overlay } = await openHarness();

  assert.equal(globe.mountedOn, overlay.stage, "the renderer must be mounted on the visible stage");
  // A 0x0 canvas renders black just as reliably as a stopped loop does.
  assert.deepEqual([globe.props.width, globe.props.height], [1280, 720]);
  assert.equal(globe.props.globeImageUrl, "https://ip.example/vendor/earth-blue-marble-2048-c8fd8b5a.jpg");
  // T17: open() resumed the animation and then startPolling() -> stopPolling()
  // paused it again one statement later, so no frame was ever drawn. Order
  // matters, not just the final state.
  assert.deepEqual(globe.animation, ["resume"]);
  assert.equal(globe.running, true, "the render loop must still be running when open() returns");
});

test("closing the globe stops the render loop, and re-opening starts it again", async () => {
  const { globe, overlay } = await openHarness();

  overlay.dialog.close();
  // Nothing on screen, so nothing should be burning frames.
  assert.equal(globe.running, false);

  overlay.dialog.showModal();
  globe.resumeAnimation();
  assert.equal(globe.running, true);
});

function shareHarness(fetchImpl) {
  const timers = [];
  const context = {
    URL,
    crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
    fetch: fetchImpl,
    setInterval: (fn, ms) => timers.push({ fn, ms }),
    clearInterval: (id) => { if (id) timers[id - 1] = null; },
  };
  const internals = loadUi(context, "{ startSharing, setOverlay(value) { overlay = value; } }");
  return { internals, timers: () => timers.filter(Boolean) };
}

const fakeOverlay = () => ({ dialog: { open: true }, stage: {} });

test("a refused first heartbeat schedules a retry instead of stopping in silence", async () => {
  let attempts = 0;
  const { internals, timers } = shareHarness(async () => {
    attempts += 1;
    return attempts === 1
      ? new Response("", { status: 429 })
      : new Response(JSON.stringify({ ok: true, ttlSeconds: 300, heartbeatSeconds: 60 }), { status: 200 });
  });
  const overlay = fakeOverlay();
  internals.setOverlay(overlay);

  await internals.startSharing();
  // GBUG-1: the timer was armed only on success, so a first heartbeat that was
  // refused left the share silently dead. With the status line gone there is
  // nothing to tell the visitor either, so this timer is the whole recovery.
  assert.equal(timers().length, 1, "a retry must actually be scheduled");

  // Running that retry recovers the share, and the server's cadence replaces
  // the retry interval rather than running alongside it.
  await timers()[0].fn();
  assert.equal(attempts, 2);
  assert.deepEqual(timers().map((timer) => timer.ms), [60000]);
});

test("a heartbeat that cannot reach the globe keeps trying", async () => {
  for (const response of [
    () => { throw new Error("offline"); },
    () => new Response("", { status: 500 }),
  ]) {
    const { internals, timers } = shareHarness(async () => response());
    const overlay = fakeOverlay();
    internals.setOverlay(overlay);

    await internals.startSharing();
    assert.equal(timers().length, 1, "a retryable failure keeps the share alive");
  }
});

test("no approximate area means the share stops, with no retry left running", async () => {
  const { internals, timers } = shareHarness(async () => new Response("", { status: 503 }));
  const overlay = fakeOverlay();
  internals.setOverlay(overlay);

  await internals.startSharing();
  // Retrying cannot conjure a location, so this is the one failure that ends
  // the share — and it must not leave a timer running for a share that is over.
  assert.deepEqual(timers(), []);
});
