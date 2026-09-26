import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import ssh2 from "ssh2";
import {
  DeviceKeyStore,
  encodeOpenSshPublicKey,
  generateDeviceKey,
  registerDeviceKey,
  sshFingerprint,
} from "../electron/device-key.ts";

const dir = mkdtempSync(path.join(tmpdir(), "agentcloud-device-key-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function hasSshKeygen(): boolean {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (error) {
    // ssh-keygen -? exits non-zero but exists.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) =>
    Buffer.from(Buffer.from(plain, "utf8").map((byte) => byte ^ 0x5a)),
  decryptString: (encrypted: Buffer) =>
    Buffer.from(encrypted.map((byte) => byte ^ 0x5a)).toString("utf8"),
};

describe("OpenSSH public key encoding", () => {
  it("encodes a known ed25519 key as the wire blob", () => {
    const raw = Buffer.alloc(32, 7);
    const encoded = encodeOpenSshPublicKey(raw);
    const blob = Buffer.from(encoded.split(" ")[1], "base64");
    assert.equal(encoded.split(" ")[0], "ssh-ed25519");
    assert.equal(blob.length, 51);
    assert.equal(blob.readUInt32BE(0), 11);
    assert.equal(blob.subarray(4, 15).toString(), "ssh-ed25519");
    assert.equal(blob.readUInt32BE(15), 32);
    assert.deepEqual(blob.subarray(19), raw);
  });

  it("matches the server's accepted public key shape", () => {
    const key = generateDeviceKey();
    assert.match(key.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]{68}={0,2}$/);
  });

  it(
    "fingerprint equals ssh-keygen -lf output",
    { skip: !hasSshKeygen() && "ssh-keygen unavailable" },
    () => {
      const key = generateDeviceKey();
      const file = path.join(dir, "id.pub");
      writeFileSync(file, `${key.publicKey}\n`);
      const output = execFileSync("ssh-keygen", ["-lf", file], { encoding: "utf8" });
      const fingerprint = output.trim().split(/\s+/)[1];
      assert.equal(fingerprint, key.fingerprint);
      assert.equal(sshFingerprint(key.publicKey), fingerprint);
      assert.match(output, /\(ED25519\)/);
    },
  );

  it(
    "private key is valid OpenSSH format (ssh-keygen -y derives the same public key)",
    { skip: !hasSshKeygen() && "ssh-keygen unavailable" },
    () => {
      const key = generateDeviceKey();
      const file = path.join(dir, "id_ed25519");
      writeFileSync(file, key.privateKey, { mode: 0o600 });
      const derived = execFileSync("ssh-keygen", ["-y", "-f", file], {
        encoding: "utf8",
      });
      assert.equal(derived.trim().split(/\s+/).slice(0, 2).join(" "), key.publicKey);
    },
  );

  it("ssh2 parses the stored private key", () => {
    const key = generateDeviceKey();
    const parsed = ssh2.utils.parseKey(key.privateKey);
    assert.ok(!(parsed instanceof Error), String(parsed));
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    assert.equal(one.type, "ssh-ed25519");
    assert.deepEqual(
      one.getPublicSSH(),
      Buffer.from(key.publicKey.split(" ")[1], "base64"),
    );
  });
});

describe("DeviceKeyStore", () => {
  it("persists one encrypted key per device and reloads it", () => {
    const storeDir = path.join(dir, "store");
    const first = new DeviceKeyStore(storeDir, fakeCrypto).ensure();
    const onDisk = readFileSync(path.join(storeDir, "device-ssh-key.bin"));
    assert.ok(!onDisk.toString("utf8").includes("PRIVATE KEY"));
    const second = new DeviceKeyStore(storeDir, fakeCrypto).ensure();
    assert.equal(second.publicKey, first.publicKey);
    assert.equal(second.privateKey, first.privateKey);
  });

  it("does not write plaintext when OS encryption is unavailable", () => {
    const storeDir = path.join(dir, "no-crypto");
    const store = new DeviceKeyStore(storeDir, {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("unavailable");
      },
      decryptString: () => {
        throw new Error("unavailable");
      },
    });
    store.ensure();
    assert.equal(store.isPersistent, false);
    assert.throws(() => readFileSync(store.path));
  });
});

describe("registerDeviceKey", () => {
  it("posts label and public key, and checks the returned fingerprint", async () => {
    const key = generateDeviceKey();
    let sent: unknown;
    const result = await registerDeviceKey(
      async (requestPath, init) => {
        assert.equal(requestPath, "/api/ssh-keys");
        assert.equal(init?.method, "POST");
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ key: { id: "k1", fingerprint: key.fingerprint } }),
          { status: 201 },
        );
      },
      "my-mac",
      key.publicKey,
    );
    assert.deepEqual(sent, { label: "my-mac", publicKey: key.publicKey });
    assert.equal(result.id, "k1");
    assert.ok(!JSON.stringify(sent).includes("PRIVATE"));
  });

  it("rejects a mismatched fingerprint from the server", async () => {
    const key = generateDeviceKey();
    await assert.rejects(
      registerDeviceKey(
        async () =>
          new Response(JSON.stringify({ key: { id: "k1", fingerprint: "SHA256:x" } }), {
            status: 200,
          }),
        "my-mac",
        key.publicKey,
      ),
      /different key fingerprint/,
    );
  });
});
