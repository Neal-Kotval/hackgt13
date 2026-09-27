import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizePublicKey, sshFingerprint } from "./ssh-keys.mjs";

// Server SSH identity for remote Codex sessions (HAC-153). One ed25519 key per
// install at <AGENTCLOUD_DATA_DIR>/codex-runner/id_ed25519 (directory 0700,
// files 0600), generated with ssh-keygen on first use. Workers add its public
// key to every new environment's `agentcloud` authorized keys; the backend uses
// the private key to run `codex app-server` over SSH. The private key is never
// read into memory here, logged, or returned by any API.

export const CODEX_RUNNER_DIRECTORY = "codex-runner";
const KEY_NAME = "id_ed25519";

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(new Error(`${command} failed for the Codex runner key`));
      else resolve(stdout);
    });
  });
}

export function codexRunnerKeyPath(dataDir = process.env.AGENTCLOUD_DATA_DIR || ".agentcloud") {
  return path.join(path.resolve(dataDir), CODEX_RUNNER_DIRECTORY, KEY_NAME);
}

function ensurePrivate(file, mode) {
  const info = lstatSync(file);
  if (info.isSymbolicLink()) throw new Error("Codex runner key path must not be a symbolic link");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error("Codex runner key is owned by another user");
  if ((info.mode & 0o777) !== mode) chmodSync(file, mode);
}

const cache = new Map();

// Returns { publicKey, fingerprint, keyFile }. Concurrent first use from the
// server and a worker is safe: each generates into a private temporary name and
// hard-links it into place, and the loser discards its copy.
export async function getCodexRunnerKey({ dataDir, keygen = run } = {}) {
  const keyFile = codexRunnerKeyPath(dataDir);
  const directory = path.dirname(keyFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensurePrivate(directory, 0o700);
  if (!existsSync(keyFile)) {
    const temporary = path.join(directory, `.${KEY_NAME}.${randomUUID()}`);
    try {
      await keygen("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "agentcloud-codex-runner", "-f", temporary]);
      chmodSync(temporary, 0o600);
      try { linkSync(temporary, keyFile); }
      catch (error) { if (error?.code !== "EEXIST") throw new Error("Could not install the Codex runner key"); }
    } finally {
      rmSync(temporary, { force: true });
      rmSync(`${temporary}.pub`, { force: true });
    }
  }
  ensurePrivate(keyFile, 0o600);
  const { mtimeMs, ino } = statSync(keyFile);
  const cached = cache.get(keyFile);
  if (cached && cached.mtimeMs === mtimeMs && cached.ino === ino) return cached.value;
  // Derive the public half from the private key so the pair is always consistent.
  const publicKey = normalizePublicKey(await keygen("ssh-keygen", ["-y", "-f", keyFile]));
  const publicFile = `${keyFile}.pub`;
  writeFileSync(publicFile, `${publicKey}\n`, { mode: 0o600 });
  ensurePrivate(publicFile, 0o600);
  const value = Object.freeze({ publicKey, fingerprint: sshFingerprint(publicKey), keyFile });
  cache.set(keyFile, { mtimeMs, ino, value });
  return value;
}

// Validates an injected runner key (workers accept one as a dependency).
export function validRunnerKey(runnerKey) {
  if (!runnerKey) return null;
  try {
    const publicKey = normalizePublicKey(runnerKey.publicKey);
    if (sshFingerprint(publicKey) !== runnerKey.fingerprint) return null;
    return { publicKey, fingerprint: runnerKey.fingerprint };
  } catch { return null; }
}
