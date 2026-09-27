import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateRunBoxJobs, requestRunBoxStop, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { migrateSshKeys, normalizePublicKey, registerSshKey, revokeSshKey } from "../lib/ssh-keys.mjs";
import { getRunBoxSshEndpoint, knownHostsLine, migrateRunBoxSsh } from "../lib/run-box-ssh.mjs";
import { createDockerSandboxProvider, sandboxInstallId } from "../lib/docker-sandbox-provider.mjs";
import { inspectContainerImage, registerContainerTemplate } from "../lib/container-templates.mjs";
import { reconcileDockerSandboxes, runSandboxSsh, workOneDockerSandboxJob } from "../lib/docker-sandbox-worker.mjs";
import { getAgentCheck, getWorkspacePath, listCleanupSteps } from "../lib/agent-check.mjs";

// Real Docker end to end: image build, container, sshd, key injection, stop.
function dockerAvailable() {
  try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }); return true; }
  catch { return false; }
}

function keypair(directory, name) {
  const keyFile = path.join(directory, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", keyFile]);
  return { keyFile, publicKey: normalizePublicKey(readFileSync(`${keyFile}.pub`, "utf8")) };
}

test("docker-local sandbox: create, ready, device SSH, denied outsider, stop", {
  skip: dockerAvailable() ? false : "docker info failed; Docker is unavailable", timeout: 15 * 60_000,
}, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-sandbox-it-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Isolated from any live worker on this Docker host.
  // A unique tag forces this test to build the current Dockerfile even when a
  // developer already has an older agentcloud-sandbox:dev image locally.
  const image = `agentcloud-sandbox:test-${sandboxInstallId(directory)}`;
  const provider = createDockerSandboxProvider({ installId: sandboxInstallId(directory), image });
  let jobId;
  try {
    db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
      CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
      CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
    migrateRunBoxJobs(db);
    migrateSshKeys(db);
    migrateRunBoxSsh(db);
    db.prepare("INSERT INTO user VALUES ('owner-1', 1), ('member-1', 1)").run();
    db.prepare("INSERT INTO member VALUES ('owner-1', 'org-1', 'owner'), ('member-1', 'org-1', 'member')").run();
    db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
    db.prepare("INSERT INTO project_membership VALUES ('member-1', 'project-1', 'member')").run();
    const device = keypair(directory, "device");
    const outsider = keypair(directory, "outsider");
    const registered = registerSshKey(db, "member-1", { label: "Member laptop", publicKey: device.publicKey });

    await provider.ensureImage();
    const cliDataDir = path.join(directory, "template-cli-data");
    const imported = JSON.parse(execFileSync("node", ["scripts/container-templates.mjs", "import",
      "--id", "cli-codex", "--label", "CLI Codex", "--image", image],
    { cwd: process.cwd(), env: { ...process.env, AGENTCLOUD_DATA_DIR: cliDataDir }, encoding: "utf8", timeout: 120_000 }));
    assert.equal(imported.template.image_ref, image);
    assert.equal(imported.evidence.codex, "codex-cli 0.157.1");
    assert.equal(JSON.parse(execFileSync("node", ["scripts/container-templates.mjs", "list"],
      { cwd: process.cwd(), env: { ...process.env, AGENTCLOUD_DATA_DIR: cliDataDir }, encoding: "utf8" })).length, 1);
    const { job } = saveRunBoxDecision(db, { idempotencyKey: "it-idem", resourceRequestId: "it-request",
      projectId: "project-1", employeeId: "owner-1", organizationId: "org-1", projectRole: "owner",
      provider: "docker-local", profileId: "local-docker-sandbox", maxDurationMinutes: 60 });
    jobId = job.id;

    const result = await workOneDockerSandboxJob(db, provider, { workerId: "it-worker" });
    assert.equal(result.state, "ready");
    // HAC-121: the worker saw the pinned Codex over SSH as agentcloud; no repo, so the workspace root.
    const agent = getAgentCheck(db, job.id);
    assert.equal(agent.state, "ready", agent.reason || "");
    assert.equal(agent.version, "0.157.1");
    assert.equal(getWorkspacePath(db, job.id), "/home/agentcloud/workspace");
    const endpoint = getRunBoxSshEndpoint(db, job.id);
    assert.equal(endpoint.host, "127.0.0.1");
    assert.equal(endpoint.username, "agentcloud");
    const knownHostsFile = path.join(directory, "known_hosts");
    writeFileSync(knownHostsFile, `${knownHostsLine(endpoint)}\n`, { mode: 0o600 });
    const connection = { host: endpoint.host, port: endpoint.port, username: "agentcloud", knownHostsFile };

    const login = await runSandboxSsh({ ...connection, keyFile: device.keyFile },
      "whoami; id -u; test -d ~/workspace && echo workspace-ok; cat ~/.ssh/authorized_keys; command -v nvidia-smi || echo no-gpu\n");
    assert.equal(login.code, 0, login.stderr);
    const lines = login.stdout.trim().split("\n");
    assert.equal(lines[0], "agentcloud");
    assert.notEqual(lines[1], "0");
    assert.equal(lines[2], "workspace-ok");
    // Only the member device key remains: the worker's one-time key was removed.
    assert.deepEqual(lines.slice(3, -1), [device.publicKey]);
    assert.equal(lines.at(-1), "no-gpu");

    // Codex, Node 22, and tmux resolve for a non-interactive device SSH command.
    const tools = await runSandboxSsh({ ...connection, keyFile: device.keyFile },
      "codex --version; node --version; tmux -V >/dev/null && echo tmux-ok; ls -A ~/.codex 2>/dev/null | grep -c auth.json || true\n");
    assert.equal(tools.code, 0, tools.stderr);
    const [codexVersion, nodeVersion, tmuxOk, authFiles] = tools.stdout.trim().split("\n");
    assert.equal(codexVersion, "codex-cli 0.157.1");
    assert.match(nodeVersion, /^v22\./);
    assert.equal(tmuxOk, "tmux-ok");
    assert.equal(authFiles, "0", "the image ships no Codex credential");
    const config = await runSandboxSsh({ ...connection, keyFile: device.keyFile },
      "stat -c '%U %a' ~/.codex/config.toml; cat ~/.codex/config.toml\n");
    assert.equal(config.code, 0, config.stderr);
    assert.equal(config.stdout, 'agentcloud 600\ncli_auth_credentials_store = "file"\n');
    const toolchain = await runSandboxSsh({ ...connection, keyFile: device.keyFile },
      "node --version; npm --version; git --version; codex --version; " +
      "command -v python3; command -v rg; command -v jq\n");
    assert.equal(toolchain.code, 0, toolchain.stderr);
    const versions = toolchain.stdout.trim().split("\n");
    assert.match(versions[0], /^v22\./);
    assert.match(versions[1], /^\d+\./);
    assert.match(versions[2], /^git version /);
    assert.equal(versions[3], "codex-cli 0.157.1");
    assert.match(versions[4], /\/python3$/);
    assert.match(versions[5], /\/rg$/);
    assert.match(versions[6], /\/jq$/);

    // The private host key is neither in the session environment nor readable from sshd's.
    const secrets = await runSandboxSsh({ ...connection, keyFile: device.keyFile },
      "env | grep -c AGENTCLOUD_ || true; cat /proc/1/environ >/dev/null 2>&1 && echo readable || echo unreadable; " +
      "cat /etc/ssh/ssh_host_ed25519_key >/dev/null 2>&1 && echo readable || echo unreadable\n");
    assert.equal(secrets.code, 0, secrets.stderr);
    assert.deepEqual(secrets.stdout.trim().split("\n"), ["0", "unreadable", "unreadable"]);

    const denied = await runSandboxSsh({ ...connection, keyFile: outsider.keyFile }, "whoami\n");
    assert.equal(denied.code, 255);
    assert.match(denied.stderr, /Permission denied/);
    const root = await runSandboxSsh({ ...connection, username: "root", keyFile: device.keyFile }, "whoami\n");
    assert.equal(root.code, 255);
    assert.match(root.stderr, /Permission denied/);

    // A wrong pinned host key is refused.
    const wrongHosts = path.join(directory, "wrong_known_hosts");
    writeFileSync(wrongHosts, `${knownHostsLine({ ...endpoint, hostPublicKey: outsider.publicKey })}\n`, { mode: 0o600 });
    const mismatch = await runSandboxSsh({ ...connection, knownHostsFile: wrongHosts, keyFile: device.keyFile }, "whoami\n");
    assert.equal(mismatch.code, 255);
    assert.match(mismatch.stderr, /Host key verification failed|REMOTE HOST IDENTIFICATION/);

    // Re-running the worker or create() never makes a second container.
    assert.equal(await workOneDockerSandboxJob(db, provider, { workerId: "it-worker-2" }), null);
    const reuse = await provider.create({ jobId: job.id, hostPrivateKeyB64: "AAAA", authorizedKeys: [device.publicKey] });
    assert.equal(reuse.reused, true);
    assert.equal((await provider.listManaged()).filter((item) => item.jobId === job.id).length, 1);

    revokeSshKey(db, "member-1", registered.key.id);
    assert.equal((await reconcileDockerSandboxes(db, provider)).find((item) => item.jobId === job.id)?.status, "access-updated");
    const revokedLogin = await runSandboxSsh({ ...connection, keyFile: device.keyFile }, "whoami\n");
    assert.equal(revokedLogin.code, 255);
    assert.match(revokedLogin.stderr, /Permission denied/);
    assert.deepEqual(getRunBoxSshEndpoint(db, job.id).authorizedFingerprints, []);

    // Seed a (fake) Codex credential and AgentCloud scratch as the agentcloud user.
    const containerId = (await provider.find(job.id)).id;
    execFileSync("docker", ["exec", "--user", "agentcloud", containerId, "bash", "-c",
      "mkdir -p ~/.codex ~/.cache/agentcloud /tmp/agentcloud-run && umask 077 && echo '{\"placeholder\":true}' > ~/.codex/auth.json"]);
    // Observe the container right before removal: cleanup must already have run.
    let beforeRemoval = null;
    const observed = { ...provider, async remove(id) {
      if (!beforeRemoval) beforeRemoval = execFileSync("docker", ["exec", "--user", "agentcloud", containerId, "bash", "-c",
        "for p in ~/.codex/auth.json ~/.cache/agentcloud /tmp/agentcloud-run; do test -e $p && echo present || echo absent; done"],
      { encoding: "utf8" }).trim().split("\n");
      return provider.remove(id);
    } };
    requestRunBoxStop(db, job.id, "owner-1");
    const stopped = await workOneDockerSandboxJob(db, observed, { workerId: "it-worker-3" });
    assert.equal(stopped.state, "stopped");
    assert.deepEqual(beforeRemoval, ["absent", "absent", "absent"]);
    assert.deepEqual(listCleanupSteps(db, job.id).map(({ step, ok }) => [step, ok]), [["cleanup-exec", true],
      ["codex-logout", true], ["remove-codex-auth", true], ["remove-scratch", true], ["verify-auth-absent", true]]);
    assert.equal(await provider.find(job.id), null);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");

    // An imported template uses its immutable image ID through the same worker
    // and must pass the same pinned SSH and stop lifecycle.
    registerSshKey(db, "member-1", { label: "Member laptop re-enrolled", publicKey: device.publicKey });
    const imageId = await inspectContainerImage(image);
    registerContainerTemplate(db, { id: "codex-template", label: "Codex template",
      imageRef: image, imageId, source: "registry" });
    const custom = saveRunBoxDecision(db, { idempotencyKey: "it-template", resourceRequestId: "it-template-request",
      projectId: "project-1", employeeId: "owner-1", organizationId: "org-1", projectRole: "owner",
      provider: "docker-local", profileId: "local-template:codex-template", maxDurationMinutes: 60 }).job;
    jobId = custom.id;
    assert.equal((await workOneDockerSandboxJob(db, provider, { workerId: "it-template-worker" })).state, "ready");
    const customEndpoint = getRunBoxSshEndpoint(db, custom.id);
    writeFileSync(knownHostsFile, `${knownHostsLine(customEndpoint)}\n`, { mode: 0o600 });
    const toolProbe = await runSandboxSsh({ host: customEndpoint.host, port: customEndpoint.port,
      username: "agentcloud", knownHostsFile, keyFile: device.keyFile },
    "set -e; codex --version; node --version; test -w ~/workspace\n");
    assert.equal(toolProbe.code, 0, toolProbe.stderr);
    assert.match(toolProbe.stdout, /codex-cli 0\.157\.1/);
    requestRunBoxStop(db, custom.id, "owner-1");
    assert.equal((await workOneDockerSandboxJob(db, provider, { workerId: "it-template-stop" })).state, "stopped");
    assert.equal(await provider.find(custom.id), null);
  } finally {
    if (jobId) await provider.remove(jobId).catch(() => {});
    try { execFileSync("docker", ["image", "rm", image], { stdio: "ignore", timeout: 30_000 }); }
    catch { /* A failed build leaves no image to remove. */ }
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("docker-local sandbox containers are scoped to one install", async () => {
  const calls = [];
  const docker = async (args) => { calls.push(args); return ""; };
  const first = createDockerSandboxProvider({ docker, installId: sandboxInstallId("/tmp/install-a") });
  await first.listManaged();
  assert.notEqual(sandboxInstallId("/tmp/install-a"), sandboxInstallId("/tmp/install-b"));
  assert.ok(calls[0].includes(`label=agentcloud.install=${sandboxInstallId("/tmp/install-a")}`));
});
