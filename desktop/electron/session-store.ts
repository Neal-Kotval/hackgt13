import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";

export type SessionPayload = {
  cookieHeader: string;
  baseUrl: string;
  updatedAt: string;
};

export type SecureBlobStore = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
};

/**
 * Persists Better Auth session cookies outside chat JSON.
 * Prefer Electron safeStorage (OS keychain-backed encryption on macOS).
 * Falls back to a mode-restricted file only when encryption is unavailable
 * (tests / unsupported platforms) — never writes cookies into threads.json.
 */
export class SessionStore {
  private readonly filePath: string;
  private readonly crypto: SecureBlobStore;

  constructor(
    directory: string,
    crypto: SecureBlobStore,
  ) {
    this.crypto = crypto;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filePath = path.join(directory, "employee-session.bin");
  }

  load(): SessionPayload | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = readFileSync(this.filePath);
      if (raw.length === 0) return null;
      const plain = this.crypto.isEncryptionAvailable()
        ? this.crypto.decryptString(raw)
        : raw.toString("utf8");
      const parsed = JSON.parse(plain) as SessionPayload;
      if (
        typeof parsed.cookieHeader !== "string" ||
        typeof parsed.baseUrl !== "string" ||
        !parsed.cookieHeader.trim()
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  save(payload: SessionPayload): void {
    const plain = JSON.stringify(payload);
    const blob = this.crypto.isEncryptionAvailable()
      ? this.crypto.encryptString(plain)
      : Buffer.from(plain, "utf8");
    writeFileSync(this.filePath, blob, { mode: 0o600 });
  }

  clear(): void {
    if (existsSync(this.filePath)) unlinkSync(this.filePath);
  }

  get path(): string {
    return this.filePath;
  }
}

/** Merge Set-Cookie name=value pairs into a Cookie request header string. */
export function mergeCookieHeader(
  existing: string | null | undefined,
  setCookieHeaders: string[],
): string {
  const jar = new Map<string, string>();
  for (const part of (existing || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    jar.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  for (const header of setCookieHeaders) {
    const first = header.split(";")[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    // Empty value or Max-Age=0 style clears — Better Auth deletes via empty/expired.
    if (!value || /Max-Age=0/i.test(header) || /Expires=Thu, 01 Jan 1970/i.test(header)) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function cookieLooksLikeSession(cookieHeader: string): boolean {
  return /better-auth\.session_token=/i.test(cookieHeader);
}
