# ip

Shows your IP address and client/request information.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Build](https://github.com/jaredsburrows/ip/actions/workflows/deploy.yml/badge.svg)](https://github.com/jaredsburrows/ip/actions)
[![Twitter Follow](https://img.shields.io/twitter/follow/jaredsburrows.svg?style=social)](https://twitter.com/jaredsburrows)

Single-page static site — no build step, one self-contained `index.html`. Served from two mirrors:

- **Cloudflare Workers** (primary): <https://ip.jaredsburrows.workers.dev/>
- **GitHub Pages** (mirror): <https://jaredsburrows.github.io/ip/>

On the Cloudflare mirror the IP, protocol, colo, and country come from Cloudflare's
same-origin `/cdn-cgi/trace`; on GitHub Pages the page falls back to
[ipify](https://www.ipify.org/). Security headers live in `_headers` (applied by
Cloudflare only) and are mirrored as a meta CSP in `index.html` so GitHub Pages
gets them too.

### Preview the website

Open `index.html` in a browser, or serve the directory:

```
python3 -m http.server
```

For a Cloudflare-accurate preview (applies `_headers` and the 404 page):

```
npx wrangler dev
```

If an edit doesn't show up, hard-refresh (Cmd+Shift+R) — the browser may
cache JS/CSS between refreshes.

### Deploy

Push to `gh-pages`. GitHub Pages publishes the branch as-is (`.nojekyll`), and
GitHub Actions deploys the same files to Cloudflare Workers
(`.github/workflows/deploy.yml`). Manual deploy: `npx wrangler deploy`.

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
