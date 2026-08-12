# ip

Shows your IP address and client/request information.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Build](https://github.com/jaredsburrows/ip/actions/workflows/build.yml/badge.svg)](https://github.com/jaredsburrows/ip/actions)
[![Twitter Follow](https://img.shields.io/twitter/follow/jaredsburrows.svg?style=social)](https://twitter.com/jaredsburrows)

One self-contained `index.html` plus a small Worker API (`worker.js`) — no build
step. Served from two mirrors:

- **Cloudflare Workers** (primary): <https://ip.jaredsburrows.workers.dev/>
- **GitHub Pages** (mirror): <https://jaredsburrows.github.io/ip/>

The page reads `GET /api/info`, a Worker endpoint that echoes what the server
sees: the HTTP method, every request header, and Cloudflare's `request.cf` data
(IP, ASN/ISP, city-level geolocation, TLS details, RTT). Static assets are served
free from the edge — only `/api/*` invokes the Worker (`run_worker_first` in
`wrangler.jsonc`). The GitHub Pages mirror calls the same API cross-origin via
CORS, with [ipify](https://www.ipify.org/) as a last-resort IP fallback.

Security headers live in `_headers` (applied by Cloudflare only) and are mirrored
as meta CSP tags in both pages so GitHub Pages gets them too — keep them in sync.

### Preview the website

Open `index.html` in a browser, or serve the directory:

```
python3 -m http.server
```

For a Cloudflare-accurate preview (applies `_headers`, the 404 page, and the
`/api/info` endpoint):

```
npx wrangler dev
```

Note that `request.cf` is only partially simulated locally — geolocation and TLS
values are real only on the deployed Worker. If an edit doesn't show up,
hard-refresh (Cmd+Shift+R) — the browser may cache JS/CSS between refreshes.

### Deploy

Push to `gh-pages`. GitHub Pages publishes the branch as-is (`.nojekyll`), and
GitHub Actions validates then deploys the same files to Cloudflare Workers
(`.github/workflows/build.yml`). Manual deploy: `npx wrangler deploy`.

License
=======

```
Copyright (C) 2026 Jared Burrows

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
