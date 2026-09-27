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
