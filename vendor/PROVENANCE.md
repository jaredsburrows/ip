# Vendored assets

These files are checked in deliberately. Vendoring keeps the hand-synced CSP
(`index.html` meta + `404.html` meta + `_headers`) untouched — `script-src
'self'` and `img-src 'self'` already cover same-origin delivery — and keeps
any third party out of the serving path. They are static assets, not runtime
dependencies: nothing installs, builds, or bundles them.

They are loaded only after the visitor clicks "View live globe".

`*.md` is excluded by `.assetsignore`, so this file is not served.

## vendor/globe.gl.min.js

- Package: `globe.gl@2.46.2` (npm), file `dist/globe.gl.min.js`
- Upstream: <https://github.com/vasturiano/globe.gl>
- Tarball: <https://registry.npmjs.org/globe.gl/-/globe.gl-2.46.2.tgz>
  - SHA-256 (tarball): `914349def3da1323fc732229c715b5be92a6fbd55346e193dc05483f72359c87`
- Vendored byte-for-byte from the tarball.
  - Size: 1,885,160 bytes
  - SHA-256: `2c3e445c04d121215910a89688b96091c8a72071c122a4f830081a39b636c94c`
- License: MIT (Copyright (c) 2019 Vasco Asturiano). Bundles three.js and
  three-globe, also MIT.
- Self-contained UMD build; it exposes `window.Globe` and is loaded as a
  classic `<script src="vendor/globe.gl.min.js">`. The much smaller
  `dist/globe.gl.mjs` is not usable here: it has bare `three` /`three-globe`
  imports that would need an import map plus the whole dependency tree.

Reproduce:

```sh
npm pack globe.gl@2.46.2
tar xzf globe.gl-2.46.2.tgz package/dist/globe.gl.min.js
shasum -a 256 package/dist/globe.gl.min.js
```

## vendor/earth-blue-marble-2048.jpg

- Imagery: NASA Visible Earth "Blue Marble" — public domain under NASA's media
  usage guidelines (<https://visibleearth.nasa.gov/>).
- Source file: `three-globe@2.45.2` (npm), `example/img/earth-blue-marble.jpg`
  - Tarball: <https://registry.npmjs.org/three-globe/-/three-globe-2.45.2.tgz>
  - SHA-256 (tarball): `f6deff6848980a4bda13b0993e5ebc929b27e791e063a5517c87115ff7e669cb`
  - Source size: 1,461,877 bytes, 4096x2048
  - Source SHA-256: `228deba2e4b600146bdcb6cfa359b8ead6aacc2b1c13550a29cd82824cfa1c01`
- Vendored as a downscaled re-encode, not byte-for-byte: 4096x2048 is far more
  texture than an overlay globe can show, and the full file would have pushed
  the lazy payload past the budget in the PRD (~1.0-1.4 MB) and the repo past
  the ~2.4 MB that was approved for vendoring.
  - Size: 522,454 bytes, 2048x1024
  - SHA-256: `c8fd8b5a73be3dbb1c871f9a302fdfd52054ece31119d29d337f3541ac760933`

Reproduce:

```sh
npm pack three-globe@2.45.2
tar xzf three-globe-2.45.2.tgz package/example/img/earth-blue-marble.jpg
sips -Z 2048 --setProperty format jpeg --setProperty formatOptions 80 \
  package/example/img/earth-blue-marble.jpg --out earth-blue-marble-2048.jpg
```

## Updating

Replace the file, update the version, size, and SHA-256 above in the same
commit, and re-check that no new CSP host is required. Neither file needs to
be current for the feature to work, so bumps are opt-in.
