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
const PRESENCE_PATH = "/api/globe/presence";

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
  .globe-controls { display: flex; flex-direction: column; gap: 0.35rem; }
  .globe-share { display: flex; gap: 0.5rem; align-items: baseline; }
  .globe-share span { font-size: 0.9rem; }
  .globe-disclosure { opacity: 0.8; }
`;

let overlay = null;
let globe = null;
let pollTimer = null;
let libraryPromise = null;

// Page memory only, for the lifetime of one share. Never written to
// localStorage, sessionStorage, or a cookie; it dies with the tab.
let shareToken = null;
let shareTimer = null;

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

  const controls = document.createElement("div");
  controls.className = "globe-controls";

  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Loading the globe…";

  // Unchecked, always. Viewing the globe never publishes anything; this is
  // the only thing that does.
  const share = document.createElement("label");
  share.className = "globe-share";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = false;
  const shareText = document.createElement("span");
  shareText.textContent = "Share my approximate area on the globe";
  share.append(checkbox, shareText);

  // The full disclosure, in the overlay, before anything is published.
  const disclosure = document.createElement("p");
  disclosure.className = "globe-disclosure";
  disclosure.textContent = "Shares a ~100 km area derived from your IP address — never your " +
    "device location, and never a street, city, or country name. Anyone viewing the globe can " +
    "see it, and it disappears within 5 minutes of you leaving.";

  const shareStatus = document.createElement("p");
  shareStatus.setAttribute("aria-live", "polite");

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());

  controls.append(status, share, disclosure, shareStatus);
  bar.append(controls, close);
  dialog.append(style, stage, bar);

  checkbox.addEventListener("change", () => {
    if (checkbox.checked) startSharing();
    else stopSharing("Your pin has been removed.");
  });

  // `dialog` gives Escape-to-close and focus handling without any extra code.
  dialog.addEventListener("close", () => {
    stopPolling();
    // Closing the globe is also an opt-out: re-opening starts unshared.
    checkbox.checked = false;
    stopSharing("");
  });
  // Last resort for a tab that is closed or backgrounded away; the pin would
  // otherwise age out on its own within the TTL.
  window.addEventListener("pagehide", () => stopSharing(""));
  document.body.append(dialog);

  return { dialog, stage, status, checkbox, shareStatus };
}

/** Publishes or refreshes this page's pin. Returns the poll-worthy outcome. */
async function heartbeat() {
  const token = shareToken;
  if (!token) return false;

  let response;
  try {
    response = await fetch(PRESENCE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    overlay.shareStatus.textContent = "Could not reach the globe — your pin may be missing.";
    return false;
  }

  // A token that never reached the server is not worth keeping around.
  if (shareToken !== token) return false;

  if (response.status === 503) {
    overlay.checkbox.checked = false;
    stopSharing("No approximate area is available for this connection, so there is nothing to share.");
    return false;
  }
  if (response.status === 429) {
    overlay.shareStatus.textContent = "The globe is busy — retrying shortly.";
    return false;
  }
  if (!response.ok) {
    overlay.shareStatus.textContent = "Could not add your pin right now.";
    return false;
  }

  const { heartbeatSeconds } = await response.json();
  if (!shareTimer && shareToken === token) {
    // Cadence comes from the server so the two can never drift apart.
    shareTimer = setInterval(heartbeat, heartbeatSeconds * 1000);
  }
  overlay.shareStatus.textContent = "You are on the globe. Untick to remove your pin.";
  return true;
}

async function startSharing() {
  // Random, unlinkable, and regenerated for every share.
  shareToken = crypto.randomUUID();
  overlay.shareStatus.textContent = "Adding your pin…";
  if (await heartbeat()) poll();
}

function stopSharing(message) {
  const token = shareToken;
  shareToken = null;
  if (shareTimer) clearInterval(shareTimer);
  shareTimer = null;
  if (overlay) overlay.shareStatus.textContent = message;
  if (!token) return;

  // keepalive so the delete still goes out when the page is going away.
  fetch(PRESENCE_PATH, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    keepalive: true,
  }).then(() => poll(), () => {});
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
  if (!globe || !overlay?.dialog.open) return;
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
