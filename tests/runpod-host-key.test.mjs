import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintForEd25519, parseScannedHostKey, pinRunpodHostKey } from "../lib/runpod-host-key.mjs";

const host = "203.0.113.25";
const port = 17445;
const body = "AAAAC3NzaC1lZDI1NTE5AAAAIAAQB/szHq/9TBoJvt59fmMSdLjzobJ1/zr6GLyXZHRB";
const fingerprint = "SHA256:2ZjxHA4HeC9HOQnoGGImhBDDYi55fVw8yMLdOhS0R2E";
const scan = () => `# ssh-keyscan banner\n[${host}]:${port} ssh-ed25519 ${body}\n`;

test("Runpod host key fingerprint agrees with OpenSSH and exact endpoint parsing", () => {
  assert.equal(fingerprintForEd25519(body), fingerprint);
  assert.deepEqual(parseScannedHostKey(scan(), host, port), { label: `[${host}]:${port}`, body });
  assert.throws(() => parseScannedHostKey(`[${host}]:22 ssh-ed25519 ${body}\n`, host, port));
  assert.throws(() => fingerprintForEd25519("AAAA"));
});

test("trusted fingerprint pins once and rejects mismatch or changed key", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentcloud-host-pin-"));
  const knownHostsFile = join(directory, "known_hosts");
  writeFileSync(knownHostsFile, "", { mode: 0o600 });
  try {
    const input = { host, port, expectedFingerprint: fingerprint, knownHostsFile };
    assert.throws(() => pinRunpodHostKey({ ...input, expectedFingerprint: `SHA256:${"A".repeat(43)}` }, { scan }),
      /does not match/);
    assert.equal(readFileSync(knownHostsFile, "utf8"), "");
    assert.equal(pinRunpodHostKey(input, { scan }).added, true);
    assert.equal(pinRunpodHostKey(input, { scan }).added, false);
    assert.equal(readFileSync(knownHostsFile, "utf8"), `[${host}]:${port} ssh-ed25519 ${body}\n`);
    const alteredBlob = Buffer.from(body, "base64");
    alteredBlob[alteredBlob.length - 1] ^= 1;
    const altered = alteredBlob.toString("base64");
    assert.throws(() => pinRunpodHostKey({ ...input,
      expectedFingerprint: fingerprintForEd25519(altered) },
    { scan: () => `[${host}]:${port} ssh-ed25519 ${altered}\n` }), /different.*already pinned/);
    assert.equal(readFileSync(knownHostsFile, "utf8"), `[${host}]:${port} ssh-ed25519 ${body}\n`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("pinning rejects malformed addresses, ambiguous scans, and loose known-hosts permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentcloud-host-pin-"));
  const knownHostsFile = join(directory, "known_hosts");
  writeFileSync(knownHostsFile, "", { mode: 0o644 });
  try {
    const input = { host, port, expectedFingerprint: fingerprint, knownHostsFile };
    assert.throws(() => pinRunpodHostKey({ ...input, host: "example.com" }, { scan }), /IPv4/);
    assert.throws(() => pinRunpodHostKey({ ...input, port: 22 }, { scan }), /port/);
    assert.throws(() => pinRunpodHostKey(input, { scan: () => `${scan()}[${host}]:${port} ssh-ed25519 ${Buffer.from(body, "base64").fill(1, 20, 21).toString("base64")}\n` }), /one Ed25519/);
    assert.throws(() => pinRunpodHostKey(input, { scan }), /private regular file/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
