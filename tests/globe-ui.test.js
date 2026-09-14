import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const html = read("index.html");
const ui = read("globe-ui.js");

// The hard acceptance criterion: with the globe unopened, the page must issue
// zero extra requests. These assertions are what keeps that true over time.
test("the page load path references no globe asset at all", () => {
  // No preload, prefetch, modulepreload, preconnect or stylesheet for them.
  for (const [, tag] of html.matchAll(/<(link|script|img|iframe)\b[^>]*>/g).map((m) => [m, m[0]])) {
    assert.equal(/globe-ui\.js|globe\.gl|vendor\//.test(tag), false, tag);
  }
  // The module is reached exactly once, and only through a dynamic import.
  assert.deepEqual(html.match(/import\("\.\/globe-ui\.js"\)/g), ['import("./globe-ui.js")']);
  assert.equal(/(?:src|href)\s*=\s*["'][^"']*globe-ui\.js/.test(html), false);
  // Nothing under vendor/ is reachable from the page; globe-ui.js loads it.
  assert.equal(/["'(]\s*\.?\/?vendor\//.test(html), false, "index.html must not reference vendor/");
  assert.match(ui, /vendor\/globe\.gl\.min\.js/);
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
  assert.deepEqual(ui.match(/https?:\/\/[^"'\s)]+/g), null);
  assert.deepEqual(ui.match(/fetch\(([^,)]+)/g), ['fetch(POSITIONS_PATH']);
  assert.match(ui, /const POSITIONS_PATH = "\/api\/globe\/positions"/);
});

test("the globe assets are served, and cached for the right length of time", () => {
  const headers = read("_headers");
  assert.match(headers, /\/vendor\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
  // Must expire with the page that imports it (the BUG-1 failure mode).
  const page = headers.match(/^\/\n {2}Cache-Control: (.+)$/m)[1];
  assert.match(headers, new RegExp(`/globe-ui\\.js\\n {2}Cache-Control: ${page}`));

  const excluded = new Set(read(".assetsignore").split("\n"));
  for (const path of ["globe-ui.js", "vendor/", "vendor/globe.gl.min.js"]) {
    assert.equal(excluded.has(path), false, `${path} must still be served`);
  }
  // The worker-only module and the provenance note are not assets.
  assert.ok(excluded.has("globe.js"));
  assert.ok(excluded.has("*.md"));
});
