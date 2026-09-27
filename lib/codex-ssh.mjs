import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexRpcClient } from "./codex-rpc.mjs";
import { getCodexRunnerKey } from "./codex-runner-key.mjs";
import { getRunBoxSshEndpoint, knownHostsLine } from "./run-box-ssh.mjs";
import { getWorkspacePath, SANDBOX_HOME } from "./agent-check.mjs";
import { remoteAgentWorktreeCommand } from "./codex-agent-worktree.mjs";

// Remote Codex sessions (HAC-153). The backend, never the desktop, opens SSH to a
// ready environment as `agentcloud` with the install's Codex runner key, pinned to
// the host key recorded in run_box_ssh_endpoint, and speaks the same app-server
// JSON-RPC as the local Docker runtime. The pinned known_hosts file lives in a
// private temporary directory that is deleted when the runtime closes.

export const NEW_ENVIRONMENT_REQUIRED = "Create a new environment to use Codex on it.";
const RUN_BOX_ID = /^[A-Za-z0-9-]{1,64}$/;
const STDERR_LIMIT = 4096;

// Errors whose message is written by AgentCloud and is safe to show as the session error.
export class CodexTransportError extends Error {
  constructor(message) { super(message); this.publicMessage = message; }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function validRemoteWorkspace(value) {
  return typeof value === "string" && value.startsWith(`${SANDBOX_HOME}/`) && value.length <= 512 &&
    !/(^|\/)\.\.?(\/|$)|[\0\n\r]/.test(value);
}

export function remoteCodexCommand(workspacePath, agentId = null, agentWorktree = false) {
  if (!validRemoteWorkspace(workspacePath)) throw new CodexTransportError("The environment has no valid workspace path.");
  if (agentWorktree) {
    if (!agentId) throw new CodexTransportError("The agent identity is missing for this worktree.");
    try { return `${remoteAgentWorktreeCommand(workspacePath, agentId)}exec codex app-server`; }
    catch { throw new CodexTransportError("The agent worktree path is invalid."); }
  }
  return `cd ${shellQuote(workspacePath)} && exec codex app-server`;
}

export function sshArguments({ host, port, username, keyFile, knownHostsFile, workspacePath, agentId, agentWorktree }) {
  return ["-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-o", "LogLevel=ERROR",
    "-i", keyFile, "-p", String(port), `${username}@${host}`, remoteCodexCommand(workspacePath, agentId, agentWorktree)];
}

// Maps ssh's stderr to a fixed message. The stderr text itself is never returned or logged.
export function classifySshFailure(stderr) {
  const text = String(stderr || "");
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* (differs|mismatch)/i.test(text))
    return "The environment's SSH host key does not match the pinned key. Codex was not started.";
  if (/Permission denied/i.test(text))
    return `The environment refused the server's SSH key. ${NEW_ENVIRONMENT_REQUIRED}`;
  if (/codex: (command )?not found|No such file or directory/i.test(text))
    return "Codex or the workspace is missing on the environment.";
  if (/Connection refused|timed out|No route to host|Could not resolve|Network is unreachable|Connection closed|Connection reset/i.test(text))
    return "Could not reach the environment over SSH.";
  return null;
}

function readTarget(db, runBoxId) {
  if (typeof runBoxId !== "string" || !RUN_BOX_ID.test(runBoxId)) throw new CodexTransportError("Invalid environment.");
  const job = db.prepare("SELECT id, state, stop_requested_at FROM run_box_job WHERE id = ?").get(runBoxId);
  if (!job) throw new CodexTransportError("Environment not found.");
  if (job.state !== "ready" || job.stop_requested_at) throw new CodexTransportError("Environment stopped");
  const endpoint = getRunBoxSshEndpoint(db, runBoxId);
  if (!endpoint) throw new CodexTransportError("The environment has no SSH endpoint.");
  return { endpoint, workspacePath: getWorkspacePath(db, runBoxId) };
}

/**
 * @param {{ runBoxId: string, sessionId?: string, installId?: string, agentId?: string, agentWorktree?: boolean,
 *   onNotification?: (method: string, params: any) => void, onExit?: (event: { message: string }) => void }} options
 * @param {{ db: any, getRunnerKey?: () => Promise<{ keyFile: string, fingerprint: string }>, spawnProcess?: any,
 *   requestTimeoutMs?: number, tmpRoot?: string, killDelayMs?: number, failureGraceMs?: number }} deps
 */
export async function createCodexSshRuntime(
  { runBoxId, agentId, agentWorktree = false, onNotification = () => {}, onExit = () => {} },
  { db, getRunnerKey = () => getCodexRunnerKey(), spawnProcess = spawn, requestTimeoutMs = 30_000,
    tmpRoot = os.tmpdir(), killDelayMs = 5_000, failureGraceMs = 2_000 } = {},
) {
  if (!db) throw new Error("Codex SSH runtime requires the database.");
  const { endpoint, workspacePath } = readTarget(db, runBoxId);
  const command = remoteCodexCommand(workspacePath, agentId, agentWorktree);
  let key;
  try { key = await getRunnerKey(); } catch { throw new CodexTransportError("The server's Codex SSH key is unavailable."); }
  // Environments created before HAC-153 (or before this install's key) do not trust this key.
  if (!endpoint.serverFingerprint || endpoint.serverFingerprint !== key?.fingerprint)
    throw new CodexTransportError(NEW_ENVIRONMENT_REQUIRED);

  const directory = mkdtempSync(path.join(tmpRoot, "agentcloud-codex-ssh-"));
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* Best effort; the directory holds only a public host key. */ }
  };
  let child;
  try {
    chmodSync(directory, 0o700);
    const knownHostsFile = path.join(directory, "known_hosts");
    writeFileSync(knownHostsFile, `${knownHostsLine(endpoint)}\n`, { mode: 0o600 });
    const args = sshArguments({ ...endpoint, keyFile: key.keyFile, knownHostsFile, workspacePath, agentId, agentWorktree });
    if (args.at(-1) !== command) throw new Error("Unexpected SSH command");
    child = spawnProcess("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    cleanup();
    throw error instanceof CodexTransportError ? error : new CodexTransportError("Could not start SSH for the Codex session.");
  }
  let stderr = "";
  child.stderr.on("data", (chunk) => { if (stderr.length < STDERR_LIMIT) stderr += String(chunk).slice(0, STDERR_LIMIT - stderr.length); });
  let exited = false;
  const exitedPromise = new Promise((resolve) => {
    const done = () => { exited = true; cleanup(); resolve(); };
    child.once("exit", done);
    child.once("error", done);
  });
  let exitMessage = null;
  const client = createCodexRpcClient(child, {
    onNotification, requestTimeoutMs, killDelayMs,
    connectErrorMessage: "Could not start SSH for the Codex session.",
    onExit: (event) => {
      cleanup();
      try { onExit({ ...event, message: exitMessage || event.message }); } catch { /* Isolate consumers. */ }
    },
  });
  try {
    await client.initialize();
  } catch (error) {
    // Give ssh a moment to exit and report why, then map it to a fixed message.
    if (!exited) await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, failureGraceMs).unref?.())]);
    cleanup();
    const reason = classifySshFailure(stderr);
    stderr = "";
    throw reason ? new CodexTransportError(reason) : error;
  }
  stderr = "";
  return {
    request: client.request,
    close() { exitMessage = "Codex connection closed."; client.close(); cleanup(); },
    async stop() { exitMessage = "Codex connection closed."; client.close(); cleanup(); },
    get closed() { return client.closed; },
  };
}
