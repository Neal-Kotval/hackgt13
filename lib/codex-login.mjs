// ChatGPT browser sign-in for Codex app-server sessions (HAC-161).
//
// `account/login/start {type: "chatgpt"}` makes Codex bind its OAuth callback
// server to 127.0.0.1 on the machine that runs app-server (codex-rs/login
// server.rs, rust-v0.157.1: DEFAULT_PORT 1455, FALLBACK_PORT 1457) and returns
// an auth.openai.com URL whose redirect_uri is http://localhost:<port>/auth/callback.
// For a remote environment the desktop tunnels that port from the Mac to the
// environment over SSH, so the browser redirect reaches Codex on the box.
//
// The authorize URL carries the OAuth state and PKCE challenge. It is returned
// to the owner who asked for it and is never stored in session events or logged.

export const CHATGPT_AUTH_ORIGIN = "https://auth.openai.com";
export const CODEX_CALLBACK_PORTS = Object.freeze([1455, 1457]);
const MAX_AUTH_URL = 4096;
const LOGIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class CodexLoginError extends Error {}

/** Returns the callback port when `authUrl` is a Codex ChatGPT authorize URL AgentCloud can tunnel; otherwise null. */
export function browserLoginCallbackPort(authUrl) {
  if (typeof authUrl !== "string" || authUrl.length > MAX_AUTH_URL) return null;
  let url;
  try { url = new URL(authUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.origin !== CHATGPT_AUTH_ORIGIN || url.username || url.password) return null;
  const redirects = url.searchParams.getAll("redirect_uri");
  if (redirects.length !== 1) return null;
  let redirect;
  try { redirect = new URL(redirects[0]); } catch { return null; }
  // Exactly http://localhost:<port>/auth/callback, as Codex builds it.
  const match = /^http:\/\/localhost:(\d{1,5})\/auth\/callback$/.exec(redirects[0]);
  if (!match || redirect.hostname !== "localhost" || redirect.search || redirect.hash) return null;
  const port = Number(match[1]);
  return CODEX_CALLBACK_PORTS.includes(port) ? port : null;
}

/**
 * Validates an `account/login/start` result for `{type: "chatgpt"}`.
 * @returns {{ method: "browser", authUrl: string, callbackPort: number, loginId: string }}
 */
export function parseBrowserLoginStart(result) {
  if (!result || typeof result !== "object" || result.type !== "chatgpt") throw new CodexLoginError("Codex browser sign-in unavailable.");
  if (typeof result.loginId !== "string" || !LOGIN_ID.test(result.loginId)) throw new CodexLoginError("Codex browser sign-in unavailable.");
  const callbackPort = browserLoginCallbackPort(result.authUrl);
  if (callbackPort === null) throw new CodexLoginError("Codex returned a sign-in address AgentCloud cannot use.");
  return { method: "browser", authUrl: result.authUrl, callbackPort, loginId: result.loginId };
}

/** `input.method` for the login action: "browser" (default) or explicit legacy-local "deviceCode". */
export function loginMethod(value) {
  if (value === undefined || value === null || value === "browser") return "browser";
  if (value === "deviceCode") return "deviceCode";
  return null;
}
