import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("both HTML mirrors keep the HTTP CSP in sync and allow IPv6 probe checks", () => {
  const policy = read("_headers").match(/Content-Security-Policy: (.+)/)[1].replace("; frame-ancestors 'none'", "");
  for (const file of ["index.html", "404.html"]) {
    const meta = read(file).match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.equal(meta, policy);
    const connectSrc = meta.match(/connect-src ([^;]+)/)[1].split(/\s+/);
    assert.ok(connectSrc.includes("https://api64.ipify.org"));
    assert.ok(!connectSrc.includes("https://api6.ipify.org"));
  }
});

test("Cloudflare assets exclude API implementation, tests, metadata, and local secrets", () => {
  const excludes = new Set(read(".assetsignore").split("\n"));
  for (const path of ["worker.js", "location.js", "tests/", "package.json", "package-lock.json", ".dev.vars*", ".env*"]) {
    assert.ok(excludes.has(path), path);
  }
  assert.ok(!excludes.has("ip-info.js"), "browser helpers must be served");
});
