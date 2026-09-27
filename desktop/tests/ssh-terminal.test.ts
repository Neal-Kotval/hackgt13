import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeOpenSshPublicKey } from "../electron/device-key.ts";
import {
  HOST_KEY_MISMATCH_MESSAGE,
  NO_AUTHORIZED_KEY_MESSAGE,
  connectionFailure,
  createHostVerifier,
  fetchRunBoxConnection,
  parseConnectionResponse,
  parsePinnedHostKey,
} from "../electron/ssh-terminal.ts";

const pinnedRaw = Buffer.alloc(32, 1);
const pinned = encodeOpenSshPublicKey(pinnedRaw);
const pinnedBlob = Buffer.from(pinned.split(" ")[1], "base64");
const otherBlob = Buffer.from(
  encodeOpenSshPublicKey(Buffer.alloc(32, 2)).split(" ")[1],
  "base64",
);

describe("createHostVerifier", () => {
  it("accepts exactly the pinned key blob", () => {
    const verify = createHostVerifier(pinned);
    assert.equal(verify(Buffer.from(pinnedBlob)), true);
  });

  it("rejects a different key and reports the mismatch", () => {
    let mismatches = 0;
    const verify = createHostVerifier(pinned, () => {
      mismatches += 1;
    });
    assert.equal(verify(otherBlob), false);
    assert.equal(verify(pinnedBlob.subarray(0, 50)), false);
    assert.equal(verify(Buffer.alloc(0)), false);
    assert.equal(mismatches, 3);
  });

  it("refuses to build a verifier without a valid pinned key", () => {
    assert.throws(() => createHostVerifier(""), /pinned/);
    assert.throws(() => createHostVerifier("ssh-rsa AAAAB3NzaC1yc2E="), /pinned/);
    // Right type label, wrong embedded type.
    const bogus = Buffer.concat([
      Buffer.from([0, 0, 0, 7]),
      Buffer.from("ssh-rsa"),
    ]).toString("base64");
    assert.throws(() => parsePinnedHostKey(`ssh-ed25519 ${bogus}`), /malformed/);
  });
});

describe("connection API mapping", () => {
  it("parses a ready connection and ignores extra fields", () => {
    const conn = parseConnectionResponse("job1", {
      runBoxId: "job1",
      host: "127.0.0.1",
      port: 2222,
      username: "agentcloud",
      hostPublicKey: pinned,
      knownHostsLine: `[127.0.0.1]:2222 ${pinned}`,
      access: "trusted-shell",
      authorized: true,
    });
    assert.equal(conn.port, 2222);
    assert.equal(conn.hostPublicKey, pinned);
  });

  it("rejects incomplete connection details", () => {
    assert.throws(() =>
      parseConnectionResponse("job1", { host: "h", port: 0, username: "u", hostPublicKey: pinned }),
    );
    assert.throws(() =>
      parseConnectionResponse("job1", { host: "h", port: 22, username: "u" }),
    );
  });

  it("maps 403 no_authorized_key to the re-provision explanation", () => {
    const error = connectionFailure(
      403,
      JSON.stringify({ error: "No key", code: "no_authorized_key" }),
    );
    assert.equal(error.message, NO_AUTHORIZED_KEY_MESSAGE);
    assert.equal(error.code, "no_authorized_key");
    // HAC-166: web-created environments may launch with only the Codex runner key.
    assert.match(NO_AUTHORIZED_KEY_MESSAGE, /created on the web/);
    assert.doesNotMatch(NO_AUTHORIZED_KEY_MESSAGE, /registered after the environment was created/);
  });

  it("maps 409 to not-ready and other 403 to access denied", () => {
    assert.match(connectionFailure(409, JSON.stringify({ error: "Job is verifying" })).message, /not ready/);
    assert.match(connectionFailure(403, "{}").message, /access/);
  });

  it("fetches with the session request function and never uses URL input", async () => {
    const calls: string[] = [];
    const conn = await fetchRunBoxConnection(async (requestPath) => {
      calls.push(requestPath);
      return new Response(
        JSON.stringify({ host: "10.0.0.5", port: 22, username: "agentcloud", hostPublicKey: pinned }),
        { status: 200 },
      );
    }, "job-123");
    assert.deepEqual(calls, ["/api/run-boxes/job-123/connection"]);
    assert.equal(conn.host, "10.0.0.5");
    await assert.rejects(fetchRunBoxConnection(async () => new Response("{}"), "../x"), /Invalid/);
  });

  it("exports the pinned-key mismatch message", () => {
    assert.equal(HOST_KEY_MISMATCH_MESSAGE, "Host key does not match the pinned key for this environment");
  });
});
