import { createHash } from "node:crypto";

const cookiePattern = /^(?:__Secure-|__Host-)?better-auth\.[a-zA-Z0-9_.-]+$/;
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Explicit opt-in. AGENTCLOUD_URL remains the desktop/CLI setting. */
export function remoteBackendURL() {
  const value = process.env.AGENTCLOUD_REMOTE_BACKEND_URL;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("AGENTCLOUD_REMOTE_BACKEND_URL must be an HTTPS origin");
  return url;
}

/** @param {Headers} headers @param {string} [protocol] */
function localOrigin(headers, protocol = "http:") {
  const host = headers.get("host");
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
    throw new Error("Remote backend preview is restricted to loopback hosts");
  const origin = new URL(`${protocol}//${host}`);
  if (!loopback.has(origin.hostname)) throw new Error("Loopback host required");
  return origin;
}

/** Validate the browser boundary before replacing Origin for the upstream. @param {Request} request */
export function assertLocalRequest(request) {
  const origin = localOrigin(request.headers, new URL(request.url).protocol);
  const supplied = request.headers.get("origin");
  if (supplied && supplied !== origin.origin) throw new Error("Cross-origin preview requests are denied");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new Error("Cross-origin preview requests are denied");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !supplied)
    throw new Error("Preview mutations require a same-origin Origin header");
  return origin;
}

/** @param {URL} upstream */
function cookiePrefix(upstream) {
  return `agentcloud_remote_${createHash("sha256").update(upstream.origin).digest("hex").slice(0, 24)}_`;
}

/** @param {Headers} incoming @param {URL} upstream */
function upstreamHeaders(incoming, upstream) {
  const result = new Headers({ origin: upstream.origin });
  for (const key of ["accept", "content-type", "last-event-id"])
    if (incoming.has(key)) result.set(key, incoming.get(key));
  const prefix = cookiePrefix(upstream);
  const cookies = [];
  for (const pair of (incoming.get("cookie") || "").split(";")) {
    const index = pair.indexOf("=");
    const name = pair.slice(0, index).trim();
    if (index < 0 || !name.startsWith(prefix)) continue;
    const original = name.slice(prefix.length);
    if (cookiePattern.test(original)) cookies.push(`${original}=${pair.slice(index + 1).trim()}`);
  }
  if (cookies.length) result.set("cookie", cookies.join("; "));
  return result;
}

/** @param {string} path @param {URL} upstream */
function apiURL(path, upstream) {
  const url = new URL(path, upstream);
  if (url.origin !== upstream.origin || !url.pathname.startsWith("/api/"))
    throw new Error("Only upstream API paths are allowed");
  return url;
}

/** Server-rendered identity reads use the same isolated remote cookie namespace.
 * @param {string} path @param {Headers} headers @param {RequestInit} [init]
 */
export async function remoteFetch(path, headers, init = {}) {
  const upstream = remoteBackendURL();
  if (!upstream) throw new Error("Remote backend is not configured");
  localOrigin(headers);
  return fetch(apiURL(path, upstream), {
    ...init, headers: upstreamHeaders(headers, upstream), cache: "no-store", redirect: "manual",
  });
}

/** @param {string} value @param {URL} upstream */
function localCookie(value, upstream) {
  const [pair, ...attributes] = value.split(";");
  const index = pair.indexOf("=");
  const name = pair.slice(0, index).trim();
  if (index < 0 || !cookiePattern.test(name)) return null;
  const safe = attributes.filter((attribute) => /^(expires|max-age)=/i.test(attribute.trim()));
  // These cookies are intentionally loopback-only. Prefix original names so HTTPS
  // __Secure-/__Host- cookies can travel over the local HTTP preview without being
  // confused with locally issued Better Auth sessions.
  return [`${cookiePrefix(upstream)}${name}=${pair.slice(index + 1)}`, ...safe, "Path=/", "HttpOnly", "SameSite=Lax"].join("; ");
}

/** @param {unknown} value @param {URL} local @param {URL} upstream */
function mapCallback(value, local, upstream) {
  if (typeof value !== "string") return value;
  const url = new URL(value, local);
  if (url.origin === local.origin) return `${upstream.origin}${url.pathname}${url.search}${url.hash}`;
  // Leave other origins for Better Auth's own callback allowlist to reject.
  return value;
}

/** @param {Request} request */
export async function proxyRemoteRequest(request) {
  const upstream = remoteBackendURL();
  if (!upstream) return null;
  let local;
  try { local = assertLocalRequest(request); }
  catch { return Response.json({ error: "Remote preview requires a same-origin loopback request" }, { status: 403 }); }
  const source = new URL(request.url);
  if (!source.pathname.startsWith("/api/")) return Response.json({ error: "API route not found" }, { status: 404 });
  const target = apiURL(`${source.pathname}${source.search}`, upstream);
  if (source.pathname.startsWith("/api/auth/")) {
    for (const key of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"])
      if (target.searchParams.has(key)) target.searchParams.set(key, String(mapCallback(target.searchParams.get(key), local, upstream)));
  }
  let body;
  if (!["GET", "HEAD"].includes(request.method)) {
    if (Number(request.headers.get("content-length")) > 32768)
      return Response.json({ error: "Request too large" }, { status: 413 });
    body = await request.text();
    if (Buffer.byteLength(body) > 32768) return Response.json({ error: "Request too large" }, { status: 413 });
    if (source.pathname.startsWith("/api/auth/") && request.headers.get("content-type")?.includes("application/json")) {
      try {
        const payload = JSON.parse(body);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          for (const key of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"])
            if (key in payload) payload[key] = mapCallback(payload[key], local, upstream);
          body = JSON.stringify(payload);
        }
      } catch { return Response.json({ error: "Invalid auth request" }, { status: 400 }); }
    }
  }
  let response;
  try {
    response = await fetch(target, { method: request.method, headers: upstreamHeaders(request.headers, upstream), body, cache: "no-store", redirect: "manual", signal: request.signal });
  } catch {
    return Response.json({ error: "Shared backend is unavailable" }, { status: 502 });
  }
  const headers = new Headers({ "cache-control": "no-store", "x-accel-buffering": "no" });
  for (const key of ["content-type", "retry-after"])
    if (response.headers.has(key)) headers.set(key, response.headers.get(key));
  const location = response.headers.get("location");
  if (location) {
    const redirect = new URL(location, upstream);
    if (redirect.origin !== upstream.origin) {
      await response.body?.cancel();
      return Response.json({ error: "External backend redirect refused" }, { status: 502 });
    }
    headers.set("location", `${local.origin}${redirect.pathname}${redirect.search}${redirect.hash}`);
  }
  for (const value of response.headers.getSetCookie()) {
    const cookie = localCookie(value, upstream);
    if (cookie) headers.append("set-cookie", cookie);
  }
  // Forward the live body, not buffered text: SSE arrival and cancellation follow
  // the upstream stream and the original request AbortSignal.
  return new Response(response.body, { status: response.status, headers });
}
