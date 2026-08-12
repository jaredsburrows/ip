/*
 * GET /api/info — echoes request data that client-side JavaScript cannot see:
 * the HTTP method, every inbound header, and Cloudflare's request.cf fields
 * (IP geolocation, ASN/ISP, TLS details, RTT).
 *
 * Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc);
 * every other path is served directly from static assets, unbilled.
 */

const API_PATH = "/api/info";

// Origins allowed to read the API cross-origin (the GitHub Pages mirror).
const ALLOWED_ORIGINS = new Set([
  "https://jaredsburrows.github.io",
]);

function baseHeaders(request) {
  const headers = {
    // Every response reflects per-request data; never cache it.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // Vary even when no Origin matched so shared caches key correctly.
    "Vary": "Origin",
  };

  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

// Pretty-printed JSON: negligible bytes after compression, friendly to curl.
function json(data, status, request) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...baseHeaders(request),
    },
  });
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname !== API_PATH) {
      return json({ error: "Not found" }, 404, request);
    }

    if (request.method === "OPTIONS") {
      // The page's simple GET needs no preflight; answered for completeness.
      return new Response(null, {
        status: 204,
        headers: {
          ...baseHeaders(request),
          "Access-Control-Allow-Methods": "GET, HEAD",
        },
      });
    }

    // request.cf is absent/partial under `wrangler dev`; real at the edge.
    const cf = request.cf ?? {};

    const headers = {};
    for (const [name, value] of request.headers) {
      headers[name] = value;
    }

    return json({
      // Connection and request, as seen by the server.
      ip: request.headers.get("CF-Connecting-IP"),
      method: request.method,
      httpProtocol: cf.httpProtocol ?? null,
      tlsVersion: cf.tlsVersion || null,
      tlsCipher: cf.tlsCipher || null,
      // Cloudflare rewrites the Accept-Encoding header before the Worker
      // sees it; the client's original value survives only in this cf field.
      acceptEncoding: cf.clientAcceptEncoding || request.headers.get("Accept-Encoding"),
      xForwardedFor: request.headers.get("X-Forwarded-For"),
      rttMs: cf.clientTcpRtt ?? cf.clientQuicRtt ?? null,

      // IP-based geolocation — city-level estimates derived from the
      // connecting IP, not from any browser permission.
      asn: cf.asn ?? null,
      asOrganization: cf.asOrganization ?? null,
      country: cf.country ?? null,
      isEUCountry: cf.isEUCountry === "1",
      continent: cf.continent ?? null,
      region: cf.region ?? null,
      regionCode: cf.regionCode ?? null,
      city: cf.city ?? null,
      postalCode: cf.postalCode ?? null,
      latitude: cf.latitude ?? null,
      longitude: cf.longitude ?? null,
      timezone: cf.timezone ?? null,
      metroCode: cf.metroCode ?? null,
      colo: cf.colo ?? null,
      verifiedBotCategory: cf.verifiedBotCategory || null,

      // Every inbound request header, exactly as the Worker received them.
      headers,
    }, 200, request);
  },
};
