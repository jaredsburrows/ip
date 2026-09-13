/*
 * GET /api/info — echoes request data that client-side JavaScript cannot see:
 * the HTTP method, every inbound header, and Cloudflare's request.cf fields
 * (IP geolocation, ASN/ISP, TLS details, RTT).
 * POST /api/location — optional, rate-limited device-coordinate city lookup.
 *
 * Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc);
 * every other path is served directly from static assets, unbilled.
 */

import { connectingIP, ipFamily } from "./ip-info.js";
import { locationEnabled, lookupLocation } from "./location.js";

const API_PATH = "/api/info";
const LOCATION_PATH = "/api/location";

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
  return new Response(request.method === "HEAD" ? null : JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...baseHeaders(request),
    },
  });
}

export default {
  async fetch(request, env = {}) {
    const { pathname } = new URL(request.url);

    if (pathname !== API_PATH && pathname !== LOCATION_PATH) {
      return json({ error: "Not found" }, 404, request);
    }

    const origin = request.headers.get("Origin");
    if (pathname === LOCATION_PATH && origin &&
        origin !== new URL(request.url).origin && !ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "Origin not allowed" }, 403, request);
    }
    const methods = pathname === LOCATION_PATH ? "POST" : "GET, HEAD";
    if (request.method === "OPTIONS") {
      // GET needs no preflight; the mirror's JSON location POST does.
      return new Response(null, {
        status: 204,
        headers: {
          ...baseHeaders(request),
          "Access-Control-Allow-Methods": methods,
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (!methods.split(", ").includes(request.method)) {
      const response = json({ error: "Method not allowed" }, 405, request);
      response.headers.set("Allow", `${methods}, OPTIONS`);
      return response;
    }
    if (pathname === LOCATION_PATH) return lookupLocation(request, env, json);

    // request.cf is absent/partial under `wrangler dev`; real at the edge.
    const cf = request.cf ?? {};
    const ip = connectingIP(request.headers);
    // Only trust managed location headers when explicitly enabled for this
    // zone. Otherwise a caller could supply those fallback values themselves.
    const geo = (field, header) => cf[field] ??
      (env.TRUST_LOCATION_HEADERS === "true" ? request.headers.get(header) : null);

    const headers = {};
    for (const [name, value] of request.headers) {
      headers[name] = value;
    }

    return json({
      // Connection and request, as seen by the server.
      ip,
      ipVersion: ipFamily(ip),
      locationLookupAvailable: locationEnabled(env),
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
      country: geo("country", "CF-IPCountry"),
      isEUCountry: cf.isEUCountry === "1",
      continent: cf.continent ?? null,
      region: geo("region", "CF-Region"),
      regionCode: geo("regionCode", "CF-Region-Code"),
      city: geo("city", "CF-IPCity"),
      postalCode: geo("postalCode", "CF-Postal-Code"),
      latitude: geo("latitude", "CF-IPLatitude"),
      longitude: geo("longitude", "CF-IPLongitude"),
      timezone: geo("timezone", "CF-Timezone"),
      metroCode: cf.metroCode ?? null,
      colo: cf.colo ?? null,
      verifiedBotCategory: cf.verifiedBotCategory || null,

      // Every inbound request header, exactly as the Worker received them.
      headers,
    }, 200, request);
  },
};
