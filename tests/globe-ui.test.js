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

test("index.html stays inside the page-weight budget", () => {
  const bytes = Buffer.byteLength(html);
  assert.ok(bytes <= 30720, `index.html is ${bytes} bytes, over the 30 KB budget`);
});

test("the button imports the globe module only once the visitor clicks", async () => {
  // Run the real handler from index.html, with the dynamic import replaced by
  // a spy (the only edit, and it is asserted).
  const source = html.match(/\n {6}function initGlobeButton\(\) \{\n[\s\S]*?\n {6}\}\n/)[0];
  assert.equal((source.match(/await import\(/g) ?? []).length, 1);

  const imports = [];
  const button = { disabled: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  const status = { textContent: null };
  const context = {
    document: { getElementById: (id) => (id === "globe-button" ? button : status) },
    __import: (specifier) => {
      imports.push(specifier);
      return Promise.resolve({ open: async () => {} });
    },
  };

  vm.runInNewContext(`${source.replace("await import(", "await __import(")}\ninitGlobeButton();`, context);
  // Wiring the button up must not fetch, import, or preload anything.
  assert.deepEqual(imports, []);
  assert.equal(status.textContent, null);

  await button.listeners.click();
  assert.deepEqual(imports, ["./globe-ui.js"]);
  assert.equal(status.textContent, "");
  assert.equal(button.disabled, false, "the button must not stay stuck after a successful open");
});

test("a failed load leaves the page usable and retryable", async () => {
  const source = html.match(/\n {6}function initGlobeButton\(\) \{\n[\s\S]*?\n {6}\}\n/)[0];
  let attempts = 0;
  const button = { disabled: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  const status = { textContent: null };
  const context = {
    document: { getElementById: (id) => (id === "globe-button" ? button : status) },
    __import: () => { attempts += 1; return Promise.reject(new Error("offline")); },
  };

  vm.runInNewContext(`${source.replace("await import(", "await __import(")}\ninitGlobeButton();`, context);
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
  assert.match(headers, new RegExp(`/globe-ui\\.js\\n {2}Cache-Control: ${page}`));

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
    assert.match(provenance, new RegExp(`^## vendor/${name.replace(/\./g, "\\.")}$`, "m"));
    assert.ok(provenance.includes(sha256), `${name}: the SHA-256 in PROVENANCE.md is not this file`);
  }
});

test("the share opt-in is unticked, unstored, and reversible", () => {
  // Strict opt-in: the checkbox is created unchecked and nothing else sets it.
  assert.match(ui, /checkbox\.checked = false;/);
  assert.deepEqual(ui.match(/checkbox\.checked = (?!false)/g), null);

  // The session token lives in page memory only.
  assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/.test(uiCode), false);
  assert.match(ui, /shareToken = crypto\.randomUUID\(\)/);

  // Untick, close, and page-away all remove the pin.
  for (const trigger of [/checkbox\.checked\)[\s\S]{0,80}stopSharing/, /addEventListener\("close"[\s\S]{0,220}stopSharing/,
    /addEventListener\("pagehide", \(\) => stopSharing/]) {
    assert.match(ui, trigger);
  }
  assert.match(ui, /method: "DELETE"[\s\S]{0,160}keepalive: true/);
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
