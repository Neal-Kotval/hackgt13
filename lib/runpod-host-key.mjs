import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";

const DEFAULT_KNOWN_HOSTS = "/var/lib/agentcloud/runpod/known_hosts";

function required(value, message) {
  if (!value) throw new Error(message);
}

export function fingerprintForEd25519(keyBody) {
  required(typeof keyBody === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(keyBody),
    "Invalid Ed25519 host key");
  const blob = Buffer.from(keyBody, "base64");
  const typeLength = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const keyLengthOffset = 4 + typeLength;
  const keyLength = blob.length >= keyLengthOffset + 4 ? blob.readUInt32BE(keyLengthOffset) : 0;
  required(typeLength === 11 && blob.subarray(4, keyLengthOffset).toString() === "ssh-ed25519" &&
    keyLength === 32 && blob.length === keyLengthOffset + 4 + keyLength,
  "Invalid Ed25519 host key");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export function parseScannedHostKey(output, host, port) {
  const label = `[${host}]:${port}`;
  const keys = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.trim().split(/\s+/);
    if (fields[0] === label && fields[1] === "ssh-ed25519" && fields.length === 3) {
      fingerprintForEd25519(fields[2]);
      keys.add(fields[2]);
    }
  }
  required(keys.size === 1, "Runpod SSH scan did not return one Ed25519 host key");
  return { label, body: [...keys][0] };
}

export function pinRunpodHostKey({ host, port, expectedFingerprint,
  knownHostsFile = DEFAULT_KNOWN_HOSTS }, { scan = (ip, mappedPort) =>
    execFileSync("ssh-keyscan", ["-T", "10", "-p", String(mappedPort), "-t", "ed25519", ip],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }) } = {}) {
  required(typeof host === "string" && isIP(host) === 4, "Runpod host must be an IPv4 address");
  required(Number.isInteger(port) && port >= 1024 && port <= 65535, "Runpod mapped SSH port is invalid");
  required(typeof expectedFingerprint === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(expectedFingerprint),
    "Expected SHA256 host fingerprint is invalid");
  required(typeof knownHostsFile === "string" && knownHostsFile.startsWith("/"), "Known-hosts path must be absolute");
  const scanned = parseScannedHostKey(scan(host, port), host, port);
  const actualFingerprint = fingerprintForEd25519(scanned.body);
  required(actualFingerprint === expectedFingerprint, "Runpod SSH host fingerprint does not match trusted value");
  const metadata = lstatSync(knownHostsFile);
  required(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0,
    "Known-hosts file must be a private regular file");
  const existing = readFileSync(knownHostsFile, "utf8");
  for (const line of existing.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.trim().split(/\s+/);
    if (fields[0]?.split(",").includes(scanned.label)) {
      if (fields[1] === "ssh-ed25519" && fields[2] === scanned.body) return { ...scanned, fingerprint: actualFingerprint, added: false };
      throw new Error("A different Runpod SSH host key is already pinned for this endpoint");
    }
  }
  appendFileSync(knownHostsFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}${scanned.label} ssh-ed25519 ${scanned.body}\n`,
    { mode: 0o600 });
  return { ...scanned, fingerprint: actualFingerprint, added: true };
}
