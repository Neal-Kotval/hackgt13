/**
 * Real Docker + real sshd + real `codex app-server` (HAC-161). Skips when
 * Docker is unavailable or AGENTCLOUD_SKIP_DOCKER_TESTS=1.
 *
 * A docker-local environment is brought to ready by the real worker with this
 * install's runner key and a desktop device key. A remote Codex session starts
 * ChatGPT browser sign-in; the desktop tunnel then forwards a request from
 * 127.0.0.1:<callbackPort> on this machine to Codex's callback server on the
 * environment. The request is GET / (Codex answers 404) so it never touches
 * /auth/callback or /cancel. The login is then cancelled; no sign-in is completed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { generateDeviceKey } from "../electron/device-key.ts";
import { CodexLoginTunnels, type LoginTunnelEvent } from "../electron/codex-login-tunnel.ts";
import { browserLoginCallbackPort } from "../src/lib/chatgpt-sign-in.ts";
// Backend modules from the repository root (plain ESM, no types).
// @ts-expect-error untyped .mjs
import { migrateRunBoxJobs, saveRunBoxDecision } from "../../lib/run-box-jobs.mjs";
// @ts-expect-error untyped .mjs
import { migrateSshKeys, normalizePublicKey, registerSshKey } from "../../lib/ssh-keys.mjs";
// @ts-expect-error untyped .mjs
import { getRunBoxSshEndpoint, knownHostsLine, migrateRunBoxSsh } from "../../lib/run-box-ssh.mjs";
// @ts-expect-error untyped .mjs
import { createDockerSandboxProvider, sandboxInstallId } from "../../lib/docker-sandbox-provider.mjs";
// @ts-expect-error untyped .mjs
import { workOneDockerSandboxJob } from "../../lib/docker-sandbox-worker.mjs";
// @ts-expect-error untyped .mjs
import { getCodexRunnerKey } from "../../lib/codex-runner-key.mjs";
// @ts-expect-error untyped .mjs
import { createCodexSshRuntime } from "../../lib/codex-ssh.mjs";
// @ts-expect-error untyped .mjs
import { createRunBoxTargets } from "../../lib/codex-targets.mjs";
// @ts-expect-error untyped .mjs
import { createCodexSessionService } from "../../lib/codex-sessions.mjs";

function dockerAvailable(): boolean {
  if (process.env.AGENTCLOUD_SKIP_DOCKER_TESTS === "1") return false;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function httpGet(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
    socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk) => {
      data += chunk;
      // tiny_http keeps the connection open; the status line and body are enough.
      if (/\r\n\r\n[\s\S]*Not Found/.test(data)) socket.end();
    });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

test("browser sign-in tunnel reaches Codex's callback server on a docker-local environment", {
  skip: dockerAvailable() ? false : "Docker is unavailable",
  timeout: 20 * 60_000,
}, async (t) => {
  if ((await portListening(1455)) || (await portListening(1457))) {
    t.skip("port 1455 or 1457 is in use on this machine");
    return;
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-codex-browser-it-"));
  const dataDir = path.join(directory, "data");
  const tmpRoot = path.join(directory, "ssh-tmp");
  mkdirSync(tmpRoot, { mode: 0o700 });
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const provider = createDockerSandboxProvider({ installId: sandboxInstallId(directory) });
  const device = generateDeviceKey("it-device");
  let jobId: string | undefined;
  let service: { close: () => void; [key: string]: any } | undefined;
  let tunnels: CodexLoginTunnels | undefined;
  try {
    db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
      CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
      CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
    migrateRunBoxJobs(db);
    migrateSshKeys(db);
    migrateRunBoxSsh(db);
    db.prepare("INSERT INTO user VALUES ('owner-1', 1)").run();
    db.prepare("INSERT INTO member VALUES ('owner-1', 'org-1', 'owner')").run();
    db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
    registerSshKey(db, "owner-1", { label: "Owner laptop", publicKey: normalizePublicKey(device.publicKey) });

    await provider.ensureImage();
    const runner = await getCodexRunnerKey({ dataDir });
    const { job } = saveRunBoxDecision(db, {
      idempotencyKey: "it-codex-browser", resourceRequestId: "it-codex-browser-request",
      projectId: "project-1", employeeId: "owner-1", organizationId: "org-1", projectRole: "owner",
      provider: "docker-local", profileId: "local-docker-sandbox", maxDurationMinutes: 60,
    });
    jobId = job.id;
    const ready = await workOneDockerSandboxJob(db, provider, {
      workerId: "it-codex-browser-worker",
      runnerKey: { publicKey: runner.publicKey, fingerprint: runner.fingerprint },
    });
    assert.equal(ready.state, "ready");

    service = createCodexSessionService({
      db, dataDir, sweepMs: 0, targets: createRunBoxTargets(db),
      runtimeFactory: (options: unknown) =>
        createCodexSshRuntime(options, { db, tmpRoot, getRunnerKey: () => getCodexRunnerKey({ dataDir }), requestTimeoutMs: 60_000 }),
    });
    const session = service.initialize({ projectId: "project-1", agentId: "agent-1", createdBy: "owner-1", runBoxId: job.id });
    const deadline = Date.now() + 120_000;
    while (!["auth_required", "error", "ready"].includes(service.get(session.id).status) && Date.now() < deadline) await sleep(250);
    assert.equal(service.get(session.id).status, "auth_required", service.get(session.id).error || "");

    const { login } = await service.action(session.id, { action: "login", method: "browser" });
    assert.equal(login.method, "browser");
    assert.match(login.authUrl, /^https:\/\/auth\.openai\.com\//);
    assert.equal(browserLoginCallbackPort(login.authUrl), login.callbackPort);
    assert.ok([1455, 1457].includes(login.callbackPort));
    assert.equal(new URL(login.authUrl).searchParams.get("redirect_uri"), `http://localhost:${login.callbackPort}/auth/callback`);
    assert.equal(JSON.stringify(service.snapshot(session.id)).includes(new URL(login.authUrl).searchParams.get("state") || "--"), false);

    // The desktop's trust path: the connection API's pinned host key and this device's key.
    const endpoint = getRunBoxSshEndpoint(db, job.id);
    const opened: string[] = [];
    const events: LoginTunnelEvent[] = [];
    tunnels = new CodexLoginTunnels({
      request: async (requestPath) => {
        assert.equal(requestPath, `/api/run-boxes/${job.id}/connection`);
        return new Response(JSON.stringify({
          runBoxId: job.id, host: endpoint.host, port: endpoint.port, username: endpoint.username,
          hostPublicKey: endpoint.hostPublicKey, knownHostsLine: knownHostsLine(endpoint), access: "trusted-shell",
        }), { status: 200 });
      },
      privateKey: () => device.privateKey,
      // Never open a real browser in a test.
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    await tunnels.start(1, (event) => events.push(event), {
      sessionId: session.id, runBoxId: job.id, authUrl: login.authUrl, callbackPort: login.callbackPort,
    });
    assert.deepEqual(opened, [login.authUrl]);

    // GET / on this Mac reaches Codex's tiny_http callback server on the environment.
    const response = await httpGet(login.callbackPort);
    assert.match(response, /^HTTP\/1\.1 404/);
    assert.match(response, /Not Found/);

    tunnels.stop(1, session.id);
    assert.equal(await portListening(login.callbackPort), false, "tunnel released the Mac port");
    assert.deepEqual(events, []);
    assert.deepEqual((await service.action(session.id, { action: "cancelLogin" })).cancelled, true);
    await sleep(500);
    assert.equal(service.get(session.id).status, "auth_required");
    assert.equal(service.get(session.id).error, null);
    await service.action(session.id, { action: "stop" });
  } finally {
    tunnels?.closeAll();
    service?.close();
    if (jobId) await provider.remove(jobId).catch(() => {});
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
