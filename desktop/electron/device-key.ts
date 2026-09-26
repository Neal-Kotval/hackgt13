/**
 * Per-device ed25519 SSH key (HAC-90). Main process only.
 *
 * The private key is generated with Node crypto, serialized as an unencrypted
 * OpenSSH private key (the format ssh2 and OpenSSH both parse), then written to
 * disk only after Electron safeStorage encryption. It never crosses IPC and is
 * never logged. Only the OpenSSH public key (`ssh-ed25519 AAAA…`) is registered
 * with AgentCloud.
 */
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { SecureBlobStore } from "./session-store.ts";

const KEY_TYPE = "ssh-ed25519";

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, data]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

/** SSH wire blob: string "ssh-ed25519" + string(32-byte public key). */
export function ed25519WireBlob(rawPublicKey: Buffer): Buffer {
  if (rawPublicKey.length !== 32) {
    throw new Error("ed25519 public keys are 32 bytes");
  }
  return Buffer.concat([sshString(KEY_TYPE), sshString(rawPublicKey)]);
}

/** OpenSSH authorized_keys form without a comment: `ssh-ed25519 <base64>`. */
export function encodeOpenSshPublicKey(rawPublicKey: Buffer): string {
  return `${KEY_TYPE} ${ed25519WireBlob(rawPublicKey).toString("base64")}`;
}

/** `SHA256:<unpadded base64>` — matches `ssh-keygen -lf` and lib/ssh-keys.mjs. */
export function sshFingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1] || "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Unencrypted `openssh-key-v1` private key (cipher/kdf "none").
 * Layout per OpenSSH PROTOCOL.key.
 */
export function encodeOpenSshPrivateKey(
  seed: Buffer,
  rawPublicKey: Buffer,
  comment = "",
): string {
  if (seed.length !== 32) throw new Error("ed25519 private seeds are 32 bytes");
  const publicBlob = ed25519WireBlob(rawPublicKey);
  const check = randomBytes(4).readUInt32BE(0);
  let privateSection = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString(KEY_TYPE),
    sshString(rawPublicKey),
    sshString(Buffer.concat([seed, rawPublicKey])),
    sshString(comment),
  ]);
  const padding: number[] = [];
  for (let i = 1; (privateSection.length + padding.length) % 8 !== 0; i += 1) {
    padding.push(i);
  }
  privateSection = Buffer.concat([privateSection, Buffer.from(padding)]);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(publicBlob),
    sshString(privateSection),
  ]);
  const base64 = body.toString("base64").replace(/.{1,70}/g, "$&\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64}-----END OPENSSH PRIVATE KEY-----\n`;
}

function rawKeyBytes(key: KeyObject, field: "x" | "d"): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x?: string; d?: string };
  const value = jwk[field];
  if (!value) throw new Error(`ed25519 JWK is missing ${field}`);
  return Buffer.from(value, "base64url");
}

export type DeviceKeyMaterial = {
  publicKey: string;
  fingerprint: string;
  /** OpenSSH-format private key. Main process only. */
  privateKey: string;
  createdAt: string;
};

export function generateDeviceKey(comment = ""): DeviceKeyMaterial {
  const pair = generateKeyPairSync("ed25519");
  const rawPublic = rawKeyBytes(pair.privateKey, "x");
  const seed = rawKeyBytes(pair.privateKey, "d");
  const publicKey = encodeOpenSshPublicKey(rawPublic);
  return {
    publicKey,
    fingerprint: sshFingerprint(publicKey),
    privateKey: encodeOpenSshPrivateKey(seed, rawPublic, comment),
    createdAt: new Date().toISOString(),
  };
}

type StoredDeviceKey = {
  version: 1;
  publicKey: string;
  privateKey: string;
  createdAt: string;
};

/**
 * Persists the device key encrypted with safeStorage. When OS encryption is
 * unavailable the key is kept in memory for this run only (never written as
 * plaintext); a new key is generated and registered on the next launch.
 */
export class DeviceKeyStore {
  private readonly filePath: string;
  private readonly crypto: SecureBlobStore;
  private cached: DeviceKeyMaterial | null = null;
  private persistent = false;

  constructor(directory: string, crypto: SecureBlobStore) {
    this.crypto = crypto;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filePath = path.join(directory, "device-ssh-key.bin");
  }

  get path(): string {
    return this.filePath;
  }

  /** True when the key is stored encrypted on disk. */
  get isPersistent(): boolean {
    return this.persistent;
  }

  private load(): DeviceKeyMaterial | null {
    if (!this.crypto.isEncryptionAvailable() || !existsSync(this.filePath)) {
      return null;
    }
    try {
      const plain = this.crypto.decryptString(readFileSync(this.filePath));
      const parsed = JSON.parse(plain) as StoredDeviceKey;
      if (
        parsed.version !== 1 ||
        typeof parsed.publicKey !== "string" ||
        typeof parsed.privateKey !== "string" ||
        !parsed.publicKey.startsWith(`${KEY_TYPE} `) ||
        !parsed.privateKey.includes("BEGIN OPENSSH PRIVATE KEY")
      ) {
        return null;
      }
      return {
        publicKey: parsed.publicKey,
        fingerprint: sshFingerprint(parsed.publicKey),
        privateKey: parsed.privateKey,
        createdAt: parsed.createdAt,
      };
    } catch {
      return null;
    }
  }

  /** Load the existing device key or create one. */
  ensure(): DeviceKeyMaterial {
    if (this.cached) return this.cached;
    const existing = this.load();
    if (existing) {
      this.cached = existing;
      this.persistent = true;
      return existing;
    }
    const created = generateDeviceKey();
    if (this.crypto.isEncryptionAvailable()) {
      const stored: StoredDeviceKey = {
        version: 1,
        publicKey: created.publicKey,
        privateKey: created.privateKey,
        createdAt: created.createdAt,
      };
      writeFileSync(
        this.filePath,
        this.crypto.encryptString(JSON.stringify(stored)),
        { mode: 0o600 },
      );
      this.persistent = true;
    } else {
      this.persistent = false;
    }
    this.cached = created;
    return created;
  }

  clear(): void {
    this.cached = null;
    this.persistent = false;
    if (existsSync(this.filePath)) unlinkSync(this.filePath);
  }
}

export type DeviceKeyStatus = {
  fingerprint: string | null;
  label: string | null;
  registered: boolean;
  persistent: boolean;
  message: string;
};

export type HumanFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** POST /api/ssh-keys { label, publicKey } — idempotent per user + fingerprint. */
export async function registerDeviceKey(
  request: HumanFetch,
  label: string,
  publicKey: string,
): Promise<{ id: string; fingerprint: string }> {
  let response: Response;
  try {
    response = await request("/api/ssh-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label.slice(0, 80), publicKey }),
    });
  } catch {
    throw new Error("Cannot reach AgentCloud to register this device's SSH key.");
  }
  const text = await response.text();
  let parsed: { key?: { id?: string; fingerprint?: string }; error?: string } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep empty
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        "This AgentCloud server does not support device SSH keys yet (POST /api/ssh-keys returned 404).",
      );
    }
    throw new Error(
      parsed.error || `Device key registration failed (${response.status}).`,
    );
  }
  if (!parsed.key?.id || !parsed.key.fingerprint) {
    throw new Error("Unexpected /api/ssh-keys response.");
  }
  if (parsed.key.fingerprint !== sshFingerprint(publicKey)) {
    throw new Error("Server registered a different key fingerprint than this device's key.");
  }
  return { id: parsed.key.id, fingerprint: parsed.key.fingerprint };
}
