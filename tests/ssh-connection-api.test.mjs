import assert from "node:assert/strict";
import { after, test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-ssh-connection-api-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
for (const name of ["store", "http", "resource-profiles"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), transpile(source).replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
const mjs = ["auth", "machine-catalog", "run-box-jobs", "ssh-keys", "run-box-ssh", "agent-check", "container-templates", "aws-organization-approval", "aws-cpu-ssh-access", "backboard", "backboard-memory"];
for (const name of ["run-box-jobs", "ssh-keys", "run-box-ssh", "agent-check", "container-templates", "aws-organization-approval", "aws-cpu-ssh-access", "backboard", "backboard-memory"])
  await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
const db = fixture.getDatabase();
const store = await import(path.join(directory, "store.js"));
const jobs = await import(path.join(directory, "run-box-jobs.mjs"));
const endpoints = await import(path.join(directory, "run-box-ssh.mjs"));
const sshKeys = await import(path.join(directory, "ssh-keys.mjs"));
const agentCheck = await import(path.join(directory, "agent-check.mjs"));
async function route(sourcePath, outputName, depth) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  const code = transpile(source).replaceAll("../".repeat(depth) + "lib/", "./")
    .replace(/from ["']\.\/([\w-]+)(?:\.mjs)?["']/g, (match, name) => `from './${name}${mjs.includes(name) ? ".mjs" : ".js"}'`);
  await writeFile(path.join(directory, outputName), code);
  return import(path.join(directory, outputName));
}
const keysRoute = await route("../app/api/ssh-keys/route.ts", "ssh-keys-route.js", 3);
const keyRoute = await route("../app/api/ssh-keys/[id]/route.ts", "ssh-key-route.js", 4);
const connection = await route("../app/api/run-boxes/[id]/connection/route.ts", "connection-route.js", 5);
const boxes = await route("../app/api/run-boxes/route.ts", "boxes-route.js", 3);
const [owner, member] = fixture.users;
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

function ed25519PublicKey() {
  const raw = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x, "base64url");
  const type = Buffer.from("ssh-ed25519");
  const length = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return `ssh-ed25519 ${Buffer.concat([length(type.length), type, length(raw.length), raw]).toString("base64")}`;
}
function call(url, { method = "GET", body, cookie, origin = "http://localhost:3000" } = {}) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id) => ({ params: Promise.resolve({ id }) });
const register = (cookie, publicKey, extra = {}) =>
  keysRoute.POST(call("/api/ssh-keys", { method: "POST", body: { label: "Laptop", publicKey }, cookie, ...extra }));

test("device SSH keys: register is idempotent, list is per-user, revocation is owner-only", async () => {
  const publicKey = ed25519PublicKey();
  assert.equal((await register(null, publicKey)).status, 401);
  const created = await register(owner.cookie, `${publicKey} laptop@example`);
  assert.equal(created.status, 201);
  const { key } = await created.json();
  assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.deepEqual(Object.keys(key).sort(), ["createdAt", "fingerprint", "id", "label"]);
  const again = await register(owner.cookie, publicKey);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).key.id, key.id);

  const listed = await (await keysRoute.GET(call("/api/ssh-keys", { cookie: owner.cookie }))).json();
  assert.deepEqual(listed.keys.map((item) => item.id), [key.id]);
  assert.equal(JSON.stringify(listed).includes(publicKey.split(" ")[1]), false);
  assert.deepEqual((await (await keysRoute.GET(call("/api/ssh-keys", { cookie: member.cookie }))).json()).keys, []);
  assert.equal((await keysRoute.GET(call("/api/ssh-keys"))).status, 401);

  assert.equal((await keyRoute.DELETE(call(`/api/ssh-keys/${key.id}`, { method: "DELETE", cookie: member.cookie }), params(key.id))).status, 404);
  assert.equal((await keyRoute.DELETE(call(`/api/ssh-keys/${key.id}`, { method: "DELETE", cookie: owner.cookie, origin: "https://evil.example" }), params(key.id))).status, 403);
  const revoked = await keyRoute.DELETE(call(`/api/ssh-keys/${key.id}`, { method: "DELETE", cookie: owner.cookie }), params(key.id));
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { ok: true });
  assert.equal((await keyRoute.DELETE(call(`/api/ssh-keys/${key.id}`, { method: "DELETE", cookie: owner.cookie }), params(key.id))).status, 404);
  assert.deepEqual((await (await keysRoute.GET(call("/api/ssh-keys", { cookie: owner.cookie }))).json()).keys, []);
  // A revoked key can be registered again as a new active key.
  const renewed = await register(owner.cookie, publicKey);
  assert.equal(renewed.status, 201);
  assert.notEqual((await renewed.json()).key.id, key.id);
});

test("device SSH keys: rejects non-ed25519, private keys, bad labels, and cross-origin browsers", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "pkcs1", format: "der" }).toString("base64");
  assert.equal((await register(owner.cookie, `ssh-rsa ${rsa}`)).status, 400);
  assert.equal((await register(owner.cookie, "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).status, 400);
  assert.equal((await register(owner.cookie, "ssh-ed25519 AAAA")).status, 400);
  assert.equal((await keysRoute.POST(call("/api/ssh-keys", { method: "POST", body: { label: "", publicKey: ed25519PublicKey() }, cookie: owner.cookie }))).status, 400);
  assert.equal((await register(owner.cookie, ed25519PublicKey(), { origin: "https://evil.example" })).status, 403);
  // Desktop main-process fetch may omit Origin; the session cookie still authenticates it.
  assert.equal((await register(owner.cookie, ed25519PublicKey(), { origin: null })).status, 201);
});

test("connection API enforces auth, membership, readiness, and injected device keys", async () => {
  const projectId = (await store.action({ type: "createProject", name: "SSH test", repo: "https://example.com/repo", compute: "Hosted Linux", template: "blank" })).id;
  fixture.grantMembership(owner.id, projectId, "owner");
  const outsiderProject = (await store.action({ type: "createProject", name: "Other", repo: "https://example.com/other", compute: "Hosted Linux", template: "blank" })).id;
  fixture.grantMembership(owner.id, outsiderProject, "owner");
  jobs.migrateRunBoxJobs(db);
  endpoints.migrateRunBoxSsh(db);
  sshKeys.migrateSshKeys(db);
  const { job } = jobs.saveRunBoxDecision(db, {
    idempotencyKey: "ssh-connection-1", resourceRequestId: "request-ssh-1", projectId,
    employeeId: owner.id, organizationId: fixture.organization.id, projectRole: "owner",
    provider: "runpod", profileId: "runpod-rtx-4090", maxDurationMinutes: 60, repoUrl: "https://example.com/repo",
  });
  const get = (cookie, id = job.id) => connection.GET(call(`/api/run-boxes/${id}/connection`, { cookie }), params(id));

  assert.equal((await get(null)).status, 401);
  assert.equal((await get(owner.cookie, "00000000-0000-0000-0000-000000000000")).status, 404);
  assert.equal((await get(member.cookie)).status, 403); // org member without project membership
  assert.equal((await get(owner.cookie)).status, 409); // queued

  db.prepare("UPDATE run_box_job SET state = 'ready' WHERE id = ?").run(job.id);
  assert.equal((await get(owner.cookie)).status, 409); // ready but no endpoint
  const withoutEndpoint = (await (await boxes.GET(call(`/api/run-boxes?projectId=${projectId}`, { cookie: owner.cookie }))).json()).jobs[0];
  assert.equal(withoutEndpoint.desktopUrl, null); // no terminal without an SSH endpoint

  const ownerKey = ed25519PublicKey();
  await register(owner.cookie, ownerKey);
  const hostPublicKey = ed25519PublicKey();
  endpoints.recordRunBoxSshEndpoint(db, job.id, { host: "203.0.113.10", port: 30222, username: "agentcloud", hostPublicKey,
    authorizedFingerprints: [sshKeys.sshFingerprint(ed25519PublicKey())] });
  const noKey = await get(owner.cookie);
  assert.equal(noKey.status, 403);
  const noKeyBody = await noKey.json();
  assert.equal(noKeyBody.code, "no_authorized_key");
  // HAC-166: a web-created environment may carry only the Codex runner key.
  assert.match(noKeyBody.error, /created on the web/);

  endpoints.recordRunBoxSshEndpoint(db, job.id, { host: "203.0.113.10", port: 30222, username: "agentcloud", hostPublicKey,
    authorizedFingerprints: [sshKeys.sshFingerprint(ownerKey)] });
  const ok = await get(owner.cookie);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    runBoxId: job.id, projectId, provider: "runpod", profileId: "runpod-rtx-4090", state: "ready",
    host: "203.0.113.10", port: 30222, username: "agentcloud", hostPublicKey,
    knownHostsLine: `[203.0.113.10]:30222 ${hostPublicKey}`, access: "trusted-shell", networkAccess: null, authorized: true,
  });

  // Revoking the device key removes access even though it was injected at allocation.
  const [ownerRow] = (await (await keysRoute.GET(call("/api/ssh-keys", { cookie: owner.cookie }))).json()).keys
    .filter((item) => item.fingerprint === sshKeys.sshFingerprint(ownerKey));
  await keyRoute.DELETE(call(`/api/ssh-keys/${ownerRow.id}`, { method: "DELETE", cookie: owner.cookie }), params(ownerRow.id));
  assert.equal((await (await get(owner.cookie)).json()).code, "no_authorized_key");

  // Listing adds profile, SSH endpoint, desktop link, and access label without dropping existing fields.
  const listed = (await (await boxes.GET(call(`/api/run-boxes?projectId=${projectId}`, { cookie: owner.cookie }))).json()).jobs;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, job.id);
  assert.equal(listed[0].state, "ready");
  assert.equal(listed[0].profile_id, "runpod-rtx-4090");
  assert.equal(listed[0].outcome, "approved");
  assert.equal(listed[0].profileId, "runpod-rtx-4090");
  assert.deepEqual(listed[0].ssh, { host: "203.0.113.10", port: 30222, username: "agentcloud" });
  assert.equal(listed[0].desktopUrl, `agentcloud://open?projectId=${projectId}&runBoxId=${job.id}`);
  assert.equal(listed[0].access, "trusted-shell");
  // Sized AWS environments: a Runpod job has no catalog machine or disk.
  assert.equal(listed[0].machine, null);
  assert.equal(listed[0].diskGb, null);
  // HAC-121: agent readiness is pending until a worker records `codex --version`; no workspace yet.
  assert.equal(listed[0].workspacePath, null);
  assert.deepEqual(listed[0].agent, { codex: { state: "pending", version: null, reason: null } });
  agentCheck.recordAgentCheck(db, job.id, { agent: "codex", ok: true, version: "0.157.1" });
  agentCheck.recordWorkspacePath(db, job.id, `/home/agentcloud/agentcloud/${job.id}/repo`);
  const checked = (await (await boxes.GET(call(`/api/run-boxes?projectId=${projectId}`, { cookie: owner.cookie }))).json()).jobs[0];
  assert.equal(checked.workspacePath, `/home/agentcloud/agentcloud/${job.id}/repo`);
  assert.deepEqual(checked.agent, { codex: { state: "ready", version: "0.157.1", reason: null } });
  agentCheck.recordAgentCheck(db, job.id, { agent: "codex", ok: false, version: "0.150.0", reason: "Codex 0.150.0 is installed; 0.157.1 is required" });
  const mismatch = (await (await boxes.GET(call(`/api/run-boxes?projectId=${projectId}`, { cookie: owner.cookie }))).json()).jobs[0];
  assert.deepEqual(mismatch.agent.codex, { state: "failed", version: "0.150.0", reason: "Codex 0.150.0 is installed; 0.157.1 is required" });
  assert.equal(mismatch.state, "ready", "SSH readiness is unchanged by a failed agent check");
  db.prepare("UPDATE run_box_job SET stop_requested_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
  const stopRequested = (await (await boxes.GET(call(`/api/run-boxes?projectId=${projectId}`, { cookie: owner.cookie }))).json()).jobs[0];
  assert.equal(stopRequested.desktopUrl, null);
  assert.equal(stopRequested.ssh, null);
  db.prepare("UPDATE run_box_job SET state = 'stopping' WHERE id = ?").run(job.id);
  const stopping = (await (await boxes.GET(call(`/api/run-boxes?projectId=${projectId}`, { cookie: owner.cookie }))).json()).jobs[0];
  assert.equal(stopping.desktopUrl, null);
  assert.equal(stopping.ssh, null);
  assert.equal(stopping.workspacePath, null);
  assert.equal((await get(owner.cookie)).status, 409);
});

test("sized AWS machines: the connection API asks the desktop to register its IPv4, and listings carry the machine", async () => {
  const approvals = await import(path.join(directory, "aws-organization-approval.mjs"));
  approvals.setAwsApproval(db, { organizationId: fixture.organization.id, approved: true,
    maxRunMinutes: 120, monthlyMinutes: 1200, actorId: owner.id });
  const projectId = (await store.action({ type: "createProject", name: "GPU SSH", repo: "https://example.com/repo", compute: "Hosted Linux", template: "blank" })).id;
  fixture.grantMembership(owner.id, projectId, "owner");
  jobs.migrateRunBoxJobs(db);
  // The single-active AWS guard spans projects; close any earlier AWS job from this file.
  db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE provider = 'aws-ec2'").run();
  const { job } = jobs.saveRunBoxDecision(db, {
    idempotencyKey: "ssh-connection-gpu", resourceRequestId: "request-ssh-gpu", projectId,
    employeeId: owner.id, organizationId: fixture.organization.id, projectRole: "owner",
    provider: "aws-ec2", profileId: "aws-gpu-t4", maxDurationMinutes: 60, repoUrl: "https://example.com/repo",
  });
  assert.equal(job.profile_id, "aws-gpu-t4");
  assert.equal(job.disk_gb, 100, "a GPU machine defaults to the catalog minimum");
  const ownerKey = ed25519PublicKey();
  await register(owner.cookie, ownerKey);
  db.prepare("UPDATE run_box_job SET state = 'ready' WHERE id = ?").run(job.id);
  endpoints.recordRunBoxSshEndpoint(db, job.id, { host: "203.0.113.20", port: 22, username: "agentcloud", hostPublicKey: ed25519PublicKey(),
    authorizedFingerprints: [sshKeys.sshFingerprint(ownerKey)] });
  const body = await (await connection.GET(call(`/api/run-boxes/${job.id}/connection`, { cookie: owner.cookie }), params(job.id))).json();
  assert.equal(body.profileId, "aws-gpu-t4");
  assert.equal(body.networkAccess, "requester-ipv4");
  const [listed] = (await (await boxes.GET(call(`/api/run-boxes?projectId=${projectId}`, { cookie: owner.cookie }))).json()).jobs;
  assert.deepEqual(listed.machine, { id: "aws-gpu-t4", kind: "gpu", size: "T4", instanceType: "g4dn.xlarge", vcpu: 4, memoryGib: 16,
    gpu: { model: "NVIDIA T4", count: 1, memoryGib: 16 } });
  assert.equal(listed.diskGb, 100);
  db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE id = ?").run(job.id);
});
