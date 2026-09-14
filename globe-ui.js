/*
 * Live globe overlay.
 *
 * Loaded only by `import("./globe-ui.js")` from the button handler in
 * index.html, so none of this — and none of vendor/ — is fetched on a normal
 * page load. Importing this module must stay side-effect free: everything
 * below runs from open().
 *
 * Read-only by default. Opening the globe makes you a viewer; publishing a pin
 * is a separate, unticked opt-in.
 */

// Resolved against this module, so the paths hold wherever the site is served.
const LIBRARY_URL = new URL("vendor/globe.gl.min.js", import.meta.url);
const TEXTURE_URL = new URL("vendor/earth-blue-marble-2048.jpg", import.meta.url);

// Same-origin only: there is no cross-origin fallback and no CORS.
const POSITIONS_PATH = "/api/globe/positions";

// Matches the read cadence in the PRD; the write cadence comes from the server.
const POLL_MS = 30000;

const OVERLAY_CSS = `
  .globe-overlay {
    width: 100%; height: 100%; max-width: 100%; max-height: 100%;
    padding: 0; border: 0; background: Canvas; color: CanvasText;
  }
  .globe-overlay::backdrop { background: rgba(0, 0, 0, 0.6); }
  .globe-stage { width: 100%; height: 100%; }
  .globe-bar {
    position: absolute; inset: auto 0 0 0;
    display: flex; gap: 1rem; align-items: center; justify-content: space-between;
    padding: 0.75rem 1rem; background: Canvas; opacity: 0.92;
  }
  .globe-bar p { margin: 0; font-size: 0.9rem; }
  .globe-bar button { margin: 0; }
`;

let overlay = null;
let globe = null;
let pollTimer = null;
let libraryPromise = null;

/** Injects the vendored UMD bundle once; it exposes window.Globe. */
function loadLibrary() {
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = LIBRARY_URL.href;
    element.addEventListener("load", () => resolve(window.Globe));
    element.addEventListener("error", () => {
      // Allow a later click to retry rather than wedging the button forever.
      libraryPromise = null;
      reject(new Error("globe.gl failed to load"));
    });
    document.head.append(element);
  });
  return libraryPromise;
}

function buildOverlay() {
  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;

  const dialog = document.createElement("dialog");
  dialog.className = "globe-overlay";
  dialog.setAttribute("aria-label", "Live globe");

  const stage = document.createElement("div");
  stage.className = "globe-stage";

  const bar = document.createElement("div");
  bar.className = "globe-bar";

  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Loading the globe…";

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());

  bar.append(status, close);
  dialog.append(style, stage, bar);
  // `dialog` gives Escape-to-close and focus handling without any extra code.
  dialog.addEventListener("close", stopPolling);
  document.body.append(dialog);

  return { dialog, stage, status };
}

function resize() {
  if (!globe || !overlay) return;
  globe.width(overlay.stage.clientWidth).height(overlay.stage.clientHeight);
}

function describe(points) {
  const people = points.reduce((total, point) => total + point.count, 0);
  if (people === 0) return "No one is sharing right now — tick the box to be the first pin.";
  const pins = points.length === 1 ? "1 area" : `${points.length} areas`;
  return `${people === 1 ? "1 person" : `${people} people`} sharing, in ${pins}.`;
}

async function poll() {
  try {
    const response = await fetch(POSITIONS_PATH, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { points } = await response.json();
    globe.pointsData(points);
    overlay.status.textContent = describe(points);
  } catch {
    // Transient by assumption: the next tick simply tries again.
    overlay.status.textContent = "Live positions are unavailable right now.";
  }
}

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  globe?.pauseAnimation();
}

/** Opens the overlay, loading the library and texture on first use. */
export async function open() {
  if (!overlay) overlay = buildOverlay();
  overlay.dialog.showModal();

  if (!globe) {
    const Globe = await loadLibrary();
    // A plain page-coloured backdrop: no star-field image to download.
    globe = new Globe(overlay.stage)
      .backgroundColor("rgba(0,0,0,0)")
      .globeImageUrl(TEXTURE_URL.href)
      .pointsData([])
      .pointLat("lat")
      .pointLng("lon")
      .pointColor(() => "#ff5252")
      .pointAltitude(0.02)
      .pointRadius(0.6)
      // Counts only. A pin never carries a place name, and never could: the
      // server does not know one to send.
      .pointLabel((point) => (point.count === 1 ? "1 person here" : `${point.count} people here`));

    const controls = globe.controls();
    controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotateSpeed = 0.35;
    window.addEventListener("resize", resize);
  }

  resize();
  globe.resumeAnimation();
  startPolling();
}
