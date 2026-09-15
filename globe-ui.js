/*
 * Live globe overlay.
 *
 * Loaded only by `import("./globe-ui.js")` from the button handler in
 * index.html, so none of this — and none of vendor/ — is fetched on a normal
 * page load. Importing this module must stay side-effect free: everything
 * below runs from open().
 *
 * Sharing is the default: opening the globe publishes this visitor's
 * approximate area, and closing it takes that straight back off. What makes
 * that defensible is not a tick-box, it is server-side (globe.js): the client
 * cannot submit a position at all, and a cell is published at ~111 km only
 * once at least 5 people share it — a lone visitor is rolled up into a
 * ~1,100 km region, or a continent-sized one. The overlay itself carries no
 * copy about any of this; that account lives in README.md.
 *
 * The globe also shows this visitor their own position, drawn from the
 * coordinates the page already received from /api/info and held in this module
 * only. It is never put in a request body, so it never reaches the Worker, the
 * Durable Object, or any other visitor's screen — the only thing this client
 * ever sends is a random token. Everyone else stays a published point, exactly
 * as before.
 */

// Resolved against this module, so the paths hold wherever the site is served.
// Both names are content-addressed (upstream version, then a SHA-256 prefix),
// which is what earns them a year of immutable caching in _headers.
const LIBRARY_URL = new URL("vendor/globe.gl-2.46.2.min.js", import.meta.url);
const TEXTURE_URL = new URL("vendor/earth-blue-marble-2048-c8fd8b5a.jpg", import.meta.url);

// Same-origin only: there is no cross-origin fallback and no CORS.
const POSITIONS_PATH = "/api/globe/positions";
const PRESENCE_PATH = "/api/globe/presence";

// Matches the read cadence in the PRD; the write cadence comes from the server.
const POLL_MS = 30000;

// How soon to try again after a heartbeat fails. Short enough that a visitor
// lands on the globe once the blip passes, long enough not to hammer a rate
// limiter that has just refused us. Every visitor takes this path now, so it
// has to be the quiet kind of retry.
const RETRY_MS = 15000;

// Said on hover over the visitor's own marker, so it cannot be mistaken for a
// pin that other people can see.
const SELF_LABEL = "You — the IP-based location already shown on this page. " +
  "Drawn in your browser only: it is never published and nobody else sees it.";

const OVERLAY_CSS = `
  .globe-overlay {
    width: 100%; height: 100%; max-width: 100%; max-height: 100%;
    padding: 0; border: 0; background: Canvas; color: CanvasText;
  }
  .globe-overlay::backdrop { background: rgba(0, 0, 0, 0.6); }
  .globe-stage { width: 100%; height: 100%; }
  /* The only chrome left. Floated over a corner of the globe rather than sat
     in a bar, because there is no longer anything for a bar to hold. */
  .globe-close {
    position: absolute; top: 1rem; right: 1rem;
    margin: 0; font: inherit; padding: 0.4rem 0.75rem; white-space: nowrap;
  }
`;

let overlay = null;
let globe = null;
let pollTimer = null;
let libraryPromise = null;

// This visitor's own marker. Page memory only, and display state and nothing
// else: it is drawn, and it is never sent anywhere.
let selfPoint = null;

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

  // Closing is the whole control, and the whole of the overlay's chrome. The
  // strip that used to run along the bottom — and everything it held — was
  // removed at the visitor's request; the account of what the globe publishes
  // belongs in README.md, not painted over the Earth on every open. Nothing
  // replaces it here, in any form.
  //
  // This button, the dialog's own Escape handling, and pagehide all run the
  // same close handler, which sends the DELETE, so the one control on screen
  // is also the one that stops publishing.
  const close = document.createElement("button");
  close.type = "button";
  close.className = "globe-close";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());

  dialog.append(style, stage, close);

  // `dialog` gives Escape-to-close and focus handling without any extra code.
  dialog.addEventListener("close", () => {
    stopPolling();
    // Nothing is on screen now, so nothing should be drawing frames.
    globe?.pauseAnimation();
    // Closing the globe takes the pin off now rather than letting it age out.
    // It is not an opt-out, though: re-opening starts sharing again, because
    // opening the globe is what sharing means here.
    stopSharing();
  });
  // Last resort for a tab that is closed or backgrounded away; the pin would
  // otherwise age out on its own within the TTL.
  window.addEventListener("pagehide", () => stopSharing());
  document.body.append(dialog);

  return { dialog, stage, close };
}

/** (Re)arms the heartbeat timer, replacing whatever was running. */
function scheduleHeartbeat(token, delayMs) {
  if (shareTimer) clearInterval(shareTimer);
  shareTimer = null;
  // The share was cancelled (or restarted) while the request was in flight.
  if (shareToken !== token) return;
  shareTimer = setInterval(heartbeat, delayMs);
}

/**
 * Keeps a failed heartbeat retryable. Arming the timer only on success meant
 * that if the *first* heartbeat failed there was no timer at all, so nothing
 * ever tried again (GBUG-1). That path runs in every visitor's first second in
 * the overlay, not just an opted-in minority's, so it has to hold — and with
 * the status line gone it is the only thing standing between a blip and a
 * silently dead share.
 */
function retryLater(token) {
  scheduleHeartbeat(token, RETRY_MS);
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
    retryLater(token);
    return false;
  }

  // A token that never reached the server is not worth keeping around.
  if (shareToken !== token) return false;

  if (response.status === 503) {
    // Nothing to publish from this connection, so retrying cannot help.
    stopSharing();
    return false;
  }
  if (response.status === 429) {
    retryLater(token);
    return false;
  }
  if (!response.ok) {
    retryLater(token);
    return false;
  }

  // Cadence comes from the server so the two can never drift apart, and each
  // success re-arms it: a retry interval never outlives the failure. A 200
  // carrying something other than a cadence is treated as a failure, rather
  // than as licence to run an interval of NaN milliseconds.
  const cadence = await response.json().then((body) => body?.heartbeatSeconds, () => null);
  if (!Number.isFinite(cadence) || cadence <= 0) {
    retryLater(token);
    return false;
  }
  scheduleHeartbeat(token, cadence * 1000);
  return true;
}

async function startSharing() {
  // Random, unlinkable, and regenerated for every share.
  shareToken = crypto.randomUUID();
  if (await heartbeat()) poll();
}

function stopSharing() {
  const token = shareToken;
  shareToken = null;
  if (shareTimer) clearInterval(shareTimer);
  shareTimer = null;
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

/**
 * The visitor's own marker, from the IP-based coordinates the page already
 * received from /api/info. Display state only: it is never put in a request
 * body, so it has no path to the Worker or to anyone else's globe. No usable
 * coordinates simply means no marker — that is not an error.
 */
function ownMarker(coords) {
  const lat = Number(coords?.lat);
  const lon = Number(coords?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

async function poll() {
  if (!globe || !overlay?.dialog.open) return;
  try {
    const response = await fetch(POSITIONS_PATH, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { points } = await response.json();
    globe.pointsData(points);
  } catch {
    // Transient by assumption: the overlay says nothing and the next tick
    // simply tries again. The globe keeps showing the last points it had,
    // which is a better answer than an error line over a spinning Earth.
  }
}

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

/**
 * Stops the read loop, and only that. Pausing the renderer from here was the
 * blank-globe bug (T17): startPolling() begins by stopping the previous loop,
 * so open()'s `resumeAnimation(); startPolling();` killed the render loop one
 * statement after starting it and no frame was ever drawn. Whether the canvas
 * is visible is the dialog's business, so the dialog pauses it.
 */
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * Opens the overlay, loading the library and texture on first use.
 *
 * `self` is this visitor's own IP-based coordinates, already on the page from
 * /api/info. They are drawn and nothing else: no request made from here ever
 * carries them, and the globe works exactly as well without them.
 */
export async function open({ self } = {}) {
  if (!overlay) overlay = buildOverlay();
  overlay.dialog.showModal();
  // Re-read on every open, so coordinates that arrived after the first one
  // still put the marker on the globe.
  selfPoint = ownMarker(self);

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
      // A bucket, never a head count, and never a place name: the server has
      // neither to send.
      .pointLabel((point) => `${point.count} people in this area`)
      // The visitor's own position — a different kind of thing from a published
      // point, so a different layer and a different colour, and local to this
      // browser alone.
      .labelsData([])
      .labelLat("lat")
      .labelLng("lon")
      .labelText(() => "You")
      .labelColor(() => "#38d6ff")
      .labelSize(1.2)
      .labelDotRadius(0.5)
      .labelAltitude(0.02)
      .labelResolution(2)
      .labelLabel(() => SELF_LABEL);

    const controls = globe.controls();
    controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotateSpeed = 0.35;
    window.addEventListener("resize", resize);
  }

  globe.labelsData(selfPoint ? [selfPoint] : []);
  resize();
  globe.resumeAnimation();
  startPolling();

  // Sharing is the default: opening the globe is what publishes your
  // approximate area, and closing it is what takes it off again. Deliberately
  // not awaited — the globe is already on screen and a slow write must not
  // hold the page's button disabled; heartbeat() reports and retries its own
  // failures.
  if (!shareToken) startSharing();
}
