// Shared by the browser, Worker, and dependency-free Node tests.
export function ipFamily(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const octets = value.split(".");
  if (octets.length === 4 && octets.every((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return 4;
  if (!value.includes(":") || !/^[\da-f:.]+$/i.test(value)) return null;
  try {
    new URL(`http://[${value}]/`);
    return 6;
  } catch {
    return null;
  }
}

export function connectingIP(headers) {
  const ip = headers.get("CF-Connecting-IP");
  const family = ipFamily(ip);
  // Overwrite Headers mode uses Class E (240/4) for a synthetic IPv4.
  // Never report that synthetic address as the visitor's actual IPv4.
  if (family === 4 && Number(ip.split(".")[0]) >= 240) {
    const ipv6 = headers.get("CF-Connecting-IPv6");
    return ipFamily(ipv6) === 6 ? ipv6 : null;
  }
  return family ? ip : null;
}

export function countryDetails(raw) {
  const code = typeof raw === "string" ? raw.toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(code) || ["XX", "ZZ", "EU", "UN"].includes(code)) return null;
  const name = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(code);
  if (!name) return null;
  const flag = [...code].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("");
  return { code, name, flag };
}

export function formatCountry(code) {
  const country = countryDetails(code);
  return country ? `${country.flag} ${country.name} (${country.code})` : null;
}

export function formatIP(ip, countryCode) {
  if (!ipFamily(ip)) return null;
  const country = countryDetails(countryCode);
  return country ? `${country.flag} ${ip}` : ip;
}

export function formatLocation({ country, region, city }) {
  return [formatCountry(country), region, city].filter(Boolean).join(" → ") || null;
}

export async function fetchJSON(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function detectIP(family) {
  const host = family === 4 ? "api.ipify.org" : "api64.ipify.org";
  const data = await fetchJSON(`https://${host}?format=json`, { cache: "no-store" });
  if (ipFamily(data.ip) !== family) throw new Error("Unexpected IP family");
  return data.ip;
}
