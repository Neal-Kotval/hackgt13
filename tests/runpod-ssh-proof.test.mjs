import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyRunpodSsh } from "../lib/runpod-ssh-proof.mjs";

const job = { id: "12345678-1234-1234-1234-123456789abc", provider: "runpod", repo_url: "https://github.com/octocat/Hello-World" };
const connection = { host: "203.0.113.10", port: 30123, keyFile: "/private/key", knownHostsFile: "/private/known_hosts",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2VwdWJsaWNrZXlmb3J0ZXN0" };

function validProof() {
  return { uid: 1000, account: "agentcloud", workspace: `/home/agentcloud/agentcloud/${job.id}`,
    repo_sha: "a".repeat(40), gpu_device: "NVIDIA RTX", nvidia_probe: "GPU 0: NVIDIA RTX",
    workload_value: 4, correct: true, cpu_ms: 1, gpu_ms: 2, elapsed_ms: 300 };
}

test("bootstraps named account and accepts only a matching GPU proof", async () => {
  const calls = [];
  const result = await verifyRunpodSsh(job, connection, { run: async (_connection, account, script) => {
    calls.push({ account, script });
    if (account === "root") return "";
    return `AGENTCLOUD_EVIDENCE=${JSON.stringify(validProof())}\n`;
  } });
  assert.deepEqual(calls.map((call) => call.account), ["root", "agentcloud"]);
  assert.match(calls[0].script, /useradd -m -s \/bin\/bash agentcloud/);
  assert.match(calls[1].script, /torch\.cuda\.is_available/);
  assert.equal(result.repo_sha, "a".repeat(40));
  assert.match(result.evidenceRef, /^ssh:12345678-1234-1234-1234-123456789abc:[a-f0-9]{64}$/);
});

test("bootstrap installs operator and member device keys for the desktop account", async () => {
  const member = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG1lbWJlcmRldmljZWtleWZvcnRlc3Rpbmdvbmx5";
  const scripts = [];
  await verifyRunpodSsh(job, { ...connection, authorizedKeys: [connection.publicKey, member] }, { run: async (_c, account, script) => {
    scripts.push(script);
    return account === "root" ? "" : `AGENTCLOUD_EVIDENCE=${JSON.stringify(validProof())}\n`;
  } });
  const encoded = scripts[0].match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/home\/agentcloud\/.ssh\/authorized_keys/)[1];
  assert.equal(Buffer.from(encoded, "base64").toString(), `${connection.publicKey}\n${member}\n`);
  let called = false;
  await assert.rejects(verifyRunpodSsh(job, { ...connection, authorizedKeys: [member] }, { run: async () => { called = true; } }),
    /authorized keys/);
  await assert.rejects(verifyRunpodSsh(job, { ...connection, authorizedKeys: [connection.publicKey, "ssh-rsa AAAA"] },
    { run: async () => { called = true; } }), /authorized keys/);
  assert.equal(called, false);
});

test("does not bootstrap when direct SSH pinning or repository is invalid", async () => {
  let called = false;
  const run = async () => { called = true; };
  await assert.rejects(verifyRunpodSsh(job, { ...connection, knownHostsFile: "" }, { run }), /pinned/);
  await assert.rejects(verifyRunpodSsh(job, { ...connection, host: "ssh.runpod.io" }, { run }), /direct SSH/);
  await assert.rejects(verifyRunpodSsh({ ...job, repo_url: "https://user:pass@example.com/repo" }, connection, { run }), /repository URL/);
  assert.equal(called, false);
});

test("rejects root execution, wrong revision, and missing CUDA proof", async () => {
  for (const mutate of [
    (proof) => { proof.uid = 0; },
    (proof) => { proof.repo_sha = "b".repeat(40); },
    (proof) => { proof.gpu_device = ""; },
    (proof) => { proof.correct = false; },
  ]) {
    const proof = validProof();
    mutate(proof);
    const run = async (_connection, account) => account === "root" ? "" : `AGENTCLOUD_EVIDENCE=${JSON.stringify(proof)}\n`;
    const pinnedJob = { ...job, repo_revision: "a".repeat(40) };
    await assert.rejects(verifyRunpodSsh(pinnedJob, connection, { run }), /proof is incomplete/);
  }
});
