import { connectingIP } from "./ip-info.js";

// Bound both request and upstream response bodies, including chunked bodies.
async function limitedJSON(message, maxBytes) {
  if (!message.body) throw new Error("Missing body");
  const reader = message.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function locationEnabled(env) {
  return Boolean(env.GEOAPIFY_API_KEY && env.LOCATION_LIMITER);
}

export async function lookupLocation(request, env, json) {
  if (!locationEnabled(env)) return json({ error: "City lookup is not configured" }, 503, request);
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "Expected application/json" }, 415, request);
  }
  let coordinates;
  try {
    coordinates = await limitedJSON(request, 1024);
  } catch {
    return json({ error: "Invalid or oversized JSON body" }, 400, request);
  }
  const { latitude, longitude } = coordinates ?? {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return json({ error: "Invalid coordinates" }, 400, request);
  }
  const ip = connectingIP(request.headers);
  if (!ip) return json({ error: "Connecting IP unavailable" }, 400, request);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // Anonymous endpoint: shared public IPs share this allowance. Counters
    // are local to a Cloudflare location, not a global provider budget cap.
    const { success } = await env.LOCATION_LIMITER.limit({ key: `ip:location:${ip}` });
    if (!success) return json({ error: "Too many lookups; try again in a minute" }, 429, request);
    const url = new URL("https://api.geoapify.com/v1/geocode/reverse");
    url.search = new URLSearchParams({
      lat: String(latitude), lon: String(longitude), type: "city",
      format: "json", limit: "1", lang: "en", apiKey: env.GEOAPIFY_API_KEY,
    });
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error("Provider unavailable");
    const result = (await limitedJSON(response, 65536)).results?.[0];
    if (!result || typeof result !== "object") throw new Error("No location found");
    const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
    return json({
      country: text(result.country_code)?.toUpperCase() ?? null,
      region: text(result.state),
      city: text(result.city) ?? text(result.town) ?? text(result.village),
      source: "device",
    }, 200, request);
  } catch {
    // Never log the URL, coordinates, provider response, or secret.
    return json({ error: "City lookup unavailable; device coordinates are still available" }, 502, request);
  } finally {
    clearTimeout(timer);
  }
}
