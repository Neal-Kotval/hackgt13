/**
 * ChatGPT device-code sign-in guard (HAC-153). The desktop opens a
 * verification URL in the system browser only when it is on OpenAI's auth
 * origin. Used by the renderer (display) and the main process (open).
 */
export const CHATGPT_AUTH_PREFIX = "https://auth.openai.com/";

export function isChatGptVerificationUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048 || !raw.startsWith(CHATGPT_AUTH_PREFIX)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.origin === "https://auth.openai.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export type DeviceLogin = { verificationUrl: string; userCode: string };

/** Accept the login route's `login` payload only when both fields are safe to show. */
export function parseDeviceLogin(value: unknown): DeviceLogin | null {
  if (!value || typeof value !== "object") return null;
  const { verificationUrl, userCode } = value as Record<string, unknown>;
  if (!isChatGptVerificationUrl(verificationUrl)) return null;
  if (typeof userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(userCode)) return null;
  return { verificationUrl, userCode };
}

/**
 * ChatGPT browser sign-in (HAC-161). Codex on the environment listens for the
 * OAuth callback on 127.0.0.1:<port> (1455, or 1457 when 1455 is busy) and
 * sends the browser to http://localhost:<port>/auth/callback. The desktop
 * tunnels that port from this Mac to the environment over SSH.
 */
export const CODEX_CALLBACK_PORTS: readonly number[] = [1455, 1457];
const MAX_AUTH_URL = 4096;

/** Callback port when `raw` is an auth.openai.com authorize URL with a tunnelable localhost redirect; otherwise null. */
export function browserLoginCallbackPort(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length > MAX_AUTH_URL || !raw.startsWith(CHATGPT_AUTH_PREFIX)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin !== "https://auth.openai.com" || url.username || url.password) return null;
  const redirects = url.searchParams.getAll("redirect_uri");
  if (redirects.length !== 1) return null;
  const match = /^http:\/\/localhost:(\d{1,5})\/auth\/callback$/.exec(redirects[0]);
  if (!match) return null;
  const port = Number(match[1]);
  return CODEX_CALLBACK_PORTS.includes(port) ? port : null;
}

export type BrowserLogin = { method: "browser"; authUrl: string; callbackPort: number; loginId: string };

/** Accept the login route's browser payload only when the URL's redirect port matches `callbackPort`. */
export function parseBrowserLogin(value: unknown): BrowserLogin | null {
  if (!value || typeof value !== "object") return null;
  const { method, authUrl, callbackPort, loginId } = value as Record<string, unknown>;
  if (method !== "browser" || typeof loginId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(loginId)) return null;
  const port = browserLoginCallbackPort(authUrl);
  if (port === null || port !== callbackPort) return null;
  return { method: "browser", authUrl: authUrl as string, callbackPort: port, loginId };
}
