import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("both pages keep the HTTP CSP in sync and reach only the ipify probe hosts", () => {
  const policy = read("_headers").match(/Content-Security-Policy: (.+)/)[1].replace("; frame-ancestors 'none'", "");
  for (const file of ["index.html", "404.html"]) {
    const meta = read(file).match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.equal(meta, policy);
    const hosts = meta.match(/connect-src ([^;]+)/)[1]
      .split(/\s+/)
      .filter((value) => value.startsWith("https://"))
      .map((value) => new URL(value).hostname);
    // The API is same-origin ('self'); only the two ipify probes are remote.
    assert.deepEqual(hosts.sort(), ["api.ipify.org", "api64.ipify.org"]);
  }
});

test("only the listed API paths run the Worker; every other path is a static asset", () => {
  const config = read("wrangler.jsonc");
  const routes = JSON.parse(config.match(/"run_worker_first":\s*(\[[^\]]*\])/)[1]);
  assert.deepEqual(routes, ["/api/info", "/api/location", "/api/globe/positions", "/api/globe/presence"]);
  // Every listed path must actually be handled, or it 404s at the Worker
  // instead of being served as an asset.
  const source = read("worker.js") + read("globe.js");
  for (const route of routes) assert.ok(source.includes(`"${route}"`), route);
  // Consequence: an unknown /api/* path never reaches worker.js, so it gets
  // the static HTML 404 page rather than the Worker's defensive JSON 404.
  assert.match(config, /"not_found_handling":\s*"404-page"/);
});

test("Cloudflare assets exclude API implementation, tests, metadata, and local secrets", () => {
  const excludes = new Set(read(".assetsignore").split("\n"));
  for (const path of ["worker.js", "location.js", "tests/", "package.json", "package-lock.json", ".dev.vars*", ".env*"]) {
    assert.ok(excludes.has(path), path);
  }
  assert.ok(!excludes.has("ip-info.js"), "browser helpers must be served");
});
