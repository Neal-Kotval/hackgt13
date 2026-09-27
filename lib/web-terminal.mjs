import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import ssh2 from "ssh2";
import { getCodexRunnerKey } from "./codex-runner-key.mjs";
import { getRunBoxSshEndpoint, migrateRunBoxSsh } from "./run-box-ssh.mjs";
import { getWorkspacePath, migrateAgentCheck, SANDBOX_HOME } from "./agent-check.mjs";
import { migrateRunBoxJobs, onRunBoxStopRequested } from "./run-box-jobs.mjs";

// Web terminal bridge (environment model, slice C). The Next server, never the
// browser, opens SSH to a ready environment as its `agentcloud` user with the
// install's runner key (lib/codex-runner-key.mjs) and accepts only the host key
// pinned in run_box_ssh_endpoint (the ssh2 equivalent of StrictHostKeyChecking=yes
// against a one-line known_hosts; there is no accept-new path). One interactive PTY
// per browser tab. The browser holds only a random session id that is bound to the
// employee and job that opened it.
//
// This is trusted shell access, not a sandbox: the shell runs with the agentcloud
// user's full rights on the environment.
//
// Nothing here logs terminal input or output, keys, or tokens. Session lifecycle is
// recorded in run_box_terminal_event (who opened/closed which job's terminal and why).
// It is a separate table so these rows never read as worker activity in
// run_box_transition (the AWS reconciler times its quiet period from that table).

export const IDLE_TIMEOUT_MS = 15 * 60_000;
export const ATTACH_TIMEOUT_MS = 20_000;
export const MAX_SESSIONS_PER_EMPLOYEE = 4;
const SWEEP_MS = 5_000;
const PENDING_LIMIT = 256 * 1024;
const INPUT_LIMIT = 16 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{32}$/;

export class WebTerminalError extends Error {
  constructor(message, status = 400, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const CLOSE_MESSAGES = Object.freeze({
  client_closed: "Terminal closed.",
  client_disconnected: "The browser disconnected.",
  attach_timeout: "The browser did not attach to the terminal in time.",
  idle_timeout: "Closed after 15 minutes without input.",
  environment_expired: "The environment reached its time limit.",
  environment_stopped: "The environment stopped.",
  access_revoked: "You no longer have access to this environment.",
  remote_exit: "The remote shell exited.",
  ssh_error: "The SSH connection to the environment was lost.",
  server_shutdown: "The server closed the terminal.",
});

export function migrateWebTerminal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS run_box_terminal_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('opened', 'closed')),
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_box_terminal_event_job ON run_box_terminal_event(job_id, id);`);
}

export function listTerminalEvents(db, jobId) {
  migrateWebTerminal(db);
  return db.prepare("SELECT job_id, employee_id, event, reason, created_at FROM run_box_terminal_event WHERE job_id = ? ORDER BY id")
    .all(jobId);
}

export function jobDeadline(job) {
  const created = Date.parse(job?.created_at);
  const minutes = Number(job?.max_duration_minutes);
  if (!Number.isFinite(created) || !Number.isFinite(minutes) || minutes <= 0) return null;
  return created + minutes * 60_000;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validWorkspace(value) {
  return typeof value === "string" && value.startsWith(`${SANDBOX_HOME}/`) && value.length <= 512 &&
    !/(^|\/)\.\.?(\/|$)|[\0\n\r]/.test(value);
}

// Start a login shell in the workspace; fall back to home when the checkout is gone.
export function terminalCommand(workspacePath) {
  const cd = validWorkspace(workspacePath) ? `cd ${shellQuote(workspacePath)} 2>/dev/null || cd; ` : "cd; ";
  return `${cd}exec "\${SHELL:-/bin/bash}" -l`;
}

function clamp(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= max ? number : fallback;
}

/** Parse a pinned `ssh-<type> <base64>` host key into its wire blob. */
export function pinnedHostKey(hostPublicKey) {
  const [type, data] = String(hostPublicKey || "").trim().split(/\s+/);
  if (!/^ssh-ed25519$/.test(type || "") || !/^[A-Za-z0-9+/]+={0,2}$/.test(data || ""))
    throw new WebTerminalError("The environment has no valid pinned host key.", 409, "no_host_key");
  const blob = Buffer.from(data, "base64");
  if (blob.length < 4 || blob.readUInt32BE(0) !== type.length || blob.subarray(4, 4 + type.length).toString("latin1") !== type)
    throw new WebTerminalError("The environment has no valid pinned host key.", 409, "no_host_key");
  return { type, blob };
}

/**
 * Default spawner: ssh2 client with the pinned host key and an interactive PTY.
 * `privateKey` is a Buffer the caller zeroes after this resolves or rejects.
 * Resolves { write, resize, close } once the PTY channel is open. Errors carry
 * fixed messages; ssh2's own text is never surfaced or logged.
 */
export function openPinnedShell({ host, port, username, hostPublicKey, privateKey, command, cols, rows, readyTimeoutMs = 20_000 },
  { onData, onClose }) {
  const pinned = pinnedHostKey(hostPublicKey);
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let settled = false;
    let closed = false;
    let mismatch = false;
    const finish = (error) => {
      if (closed) return;
      closed = true;
      try { onClose(error ? { error } : {}); } catch { /* Isolate consumers. */ }
    };
    const fail = (reason) => {
      if (!settled) {
        settled = true;
        closed = true;
        try { client.end(); } catch { /* Already closed. */ }
        reject(new WebTerminalError(mismatch ? "The environment's SSH host key does not match the pinned key. The terminal was not opened." : reason, 502,
          mismatch ? "host_key_mismatch" : "ssh_failed"));
        return;
      }
      finish(reason);
      try { client.end(); } catch { /* Already closed. */ }
    };
    client.on("error", (error) => fail(error?.level === "client-authentication"
      ? "The environment refused the server's SSH key. Create a new environment to use the web terminal."
      : "Could not reach the environment over SSH."));
    client.on("close", () => {
      if (!settled) fail("The SSH connection closed before the terminal opened.");
      else finish();
    });
    client.on("ready", () => {
      client.exec(command, { pty: { term: "xterm-256color", cols: clamp(cols, 80, 500), rows: clamp(rows, 24, 200) } }, (error, stream) => {
        if (error) { fail("The environment did not open a terminal."); return; }
        stream.on("data", (chunk) => onData(chunk));
        stream.stderr.on("data", (chunk) => onData(chunk));
        stream.on("close", () => { finish(); try { client.end(); } catch { /* Already closed. */ } });
        settled = true;
        resolve({
          write(data) { if (!closed) stream.write(data); },
          resize(nextCols, nextRows) { if (!closed) stream.setWindow(clamp(nextRows, 24, 200), clamp(nextCols, 80, 500), 0, 0); },
          close() { if (closed) return; try { stream.close(); } catch { /* Already closed. */ } try { client.end(); } catch { /* Already closed. */ } },
        });
      });
    });
    try {
      client.connect({
        host, port, username, privateKey, readyTimeout: readyTimeoutMs,
        keepaliveInterval: 15_000, keepaliveCountMax: 4,
        algorithms: { serverHostKey: [pinned.type] },
        hostVerifier: (key) => {
          const ok = Buffer.isBuffer(key) && key.length === pinned.blob.length && key.equals(pinned.blob);
          if (!ok) mismatch = true;
          return ok;
        },
      });
    } catch {
      fail("Could not start SSH for the terminal.");
    }
  });
}

/**
 * @param {{ db: any, openShell?: typeof openPinnedShell, getRunnerKey?: () => Promise<{ keyFile: string, fingerprint: string }>,
 *   readKey?: (file: string) => Buffer, now?: () => number, idleTimeoutMs?: number, attachTimeoutMs?: number,
 *   sweepMs?: number, maxPerEmployee?: number, subscribeStop?: (listener: (jobId: string) => void) => () => void }} deps
 */
export function createWebTerminalService({ db, openShell = openPinnedShell, getRunnerKey = () => getCodexRunnerKey(),
  readKey = (file) => readFileSync(file), now = () => Date.now(), idleTimeoutMs = IDLE_TIMEOUT_MS,
  attachTimeoutMs = ATTACH_TIMEOUT_MS, sweepMs = SWEEP_MS, maxPerEmployee = MAX_SESSIONS_PER_EMPLOYEE,
  subscribeStop = onRunBoxStopRequested } = {}) {
  if (!db) throw new Error("Web terminal requires the database.");
  migrateRunBoxJobs(db);
  migrateRunBoxSsh(db);
  migrateAgentCheck(db);
  migrateWebTerminal(db);
  const sessions = new Map();

  const audit = (session, event, reason = null) => {
    try {
      db.prepare("INSERT INTO run_box_terminal_event (job_id, employee_id, event, reason, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(session.jobId, session.employeeId, event, reason, new Date(now()).toISOString());
    } catch { /* Audit failure must not keep a shell open or leak content; nothing is logged. */ }
  };

  const jobRow = (jobId) => db.prepare("SELECT id, project_id, state, stop_requested_at, created_at, max_duration_minutes FROM run_box_job WHERE id = ?").get(jobId);

  function closeSession(session, reason) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    if (session.attachTimer) clearTimeout(session.attachTimer);
    session.pending = [];
    try { session.shell?.close(); } catch { /* Best effort. */ }
    if (session.opened) audit(session, "closed", reason);
    const listener = session.listener;
    session.listener = null;
    if (listener) {
      try { listener({ type: "close", reason, message: CLOSE_MESSAGES[reason] || CLOSE_MESSAGES.client_closed }); } catch { /* Isolate consumers. */ }
    }
  }

  function deliver(session, chunk) {
    if (session.closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (session.listener) {
      try { session.listener({ type: "data", data }); } catch { /* Isolate consumers. */ }
      return;
    }
    session.pending.push(data);
    session.pendingBytes += data.length;
    while (session.pendingBytes > PENDING_LIMIT && session.pending.length > 1)
      session.pendingBytes -= session.pending.shift().length;
  }

  function lookup(sessionId, employeeId, jobId) {
    const session = typeof sessionId === "string" && SESSION_ID.test(sessionId) ? sessions.get(sessionId) : null;
    // One message for every mismatch so a session id reveals nothing to another employee.
    if (!session || session.closed || session.employeeId !== employeeId || session.jobId !== jobId)
      throw new WebTerminalError("Terminal session not found", 404, "no_session");
    return session;
  }

  async function open({ employeeId, projectId, jobId, cols, rows }) {
    if (typeof employeeId !== "string" || !employeeId) throw new WebTerminalError("Employee sign-in required", 401);
    const job = jobRow(jobId);
    if (!job || job.project_id !== projectId) throw new WebTerminalError("Run-box job not found", 404);
    if (job.state !== "ready" || job.stop_requested_at)
      throw new WebTerminalError("The environment is not ready for a terminal.", 409, "not_ready");
    const deadline = jobDeadline(job);
    if (deadline !== null && now() >= deadline)
      throw new WebTerminalError("The environment reached its time limit.", 409, "not_ready");
    const endpoint = getRunBoxSshEndpoint(db, jobId);
    if (!endpoint) throw new WebTerminalError("The environment has no SSH endpoint yet.", 409, "not_ready");
    pinnedHostKey(endpoint.hostPublicKey);
    if ([...sessions.values()].filter((item) => item.employeeId === employeeId).length >= maxPerEmployee)
      throw new WebTerminalError(`You already have ${maxPerEmployee} terminals open. Close one first.`, 429, "too_many");
    let key;
    try { key = await getRunnerKey(); } catch { throw new WebTerminalError("The server's SSH key is unavailable.", 503, "no_server_key"); }
    if (!endpoint.serverFingerprint || endpoint.serverFingerprint !== key?.fingerprint)
      throw new WebTerminalError("This environment does not trust this server's SSH key. Create a new environment to use the web terminal.", 409, "no_server_key");

    const session = { id: randomBytes(24).toString("base64url"), employeeId, projectId, jobId, deadline,
      lastActivity: now(), listener: null, attached: false, pending: [], pendingBytes: 0, shell: null,
      opened: false, closed: false, attachTimer: null };
    sessions.set(session.id, session);
    let privateKey = null;
    try {
      privateKey = readKey(key.keyFile);
      session.shell = await openShell({ host: endpoint.host, port: endpoint.port, username: endpoint.username,
        hostPublicKey: endpoint.hostPublicKey, privateKey, command: terminalCommand(getWorkspacePath(db, jobId)),
        cols: clamp(cols, 80, 500), rows: clamp(rows, 24, 200) },
      { onData: (chunk) => deliver(session, chunk),
        onClose: (info) => closeSession(session, info?.error ? "ssh_error" : "remote_exit") });
    } catch (error) {
      sessions.delete(session.id);
      session.closed = true;
      throw error instanceof WebTerminalError ? error : new WebTerminalError("Could not open the terminal over SSH.", 502, "ssh_failed");
    } finally {
      if (Buffer.isBuffer(privateKey)) privateKey.fill(0);
      privateKey = null;
    }
    if (session.closed) {
      // The environment stopped (or the shell ended) while SSH was connecting.
      try { session.shell.close(); } catch { /* Best effort. */ }
      throw new WebTerminalError("The environment stopped while the terminal was opening.", 409, "not_ready");
    }
    session.opened = true;
    audit(session, "opened");
    session.attachTimer = setTimeout(() => closeSession(session, "attach_timeout"), attachTimeoutMs);
    session.attachTimer.unref?.();
    return { sessionId: session.id, expiresAt: deadline === null ? null : new Date(deadline).toISOString(), idleTimeoutMs };
  }

  // One stream per session (one browser tab). The returned function detaches and
  // closes the session: a disconnected client never leaves a shell running.
  function attach(sessionId, employeeId, jobId, listener) {
    const session = lookup(sessionId, employeeId, jobId);
    if (session.attached) throw new WebTerminalError("This terminal is already open in another tab.", 409, "attached");
    session.attached = true;
    if (session.attachTimer) { clearTimeout(session.attachTimer); session.attachTimer = null; }
    session.listener = listener;
    const pending = session.pending;
    session.pending = [];
    session.pendingBytes = 0;
    for (const data of pending) {
      if (session.listener !== listener) break;
      try { listener({ type: "data", data }); } catch { /* Isolate consumers. */ }
    }
    return () => closeSession(session, "client_disconnected");
  }

  function input(sessionId, employeeId, jobId, data) {
    const session = lookup(sessionId, employeeId, jobId);
    if (typeof data !== "string" || !data.length || data.length > INPUT_LIMIT) throw new WebTerminalError("Invalid terminal input");
    session.lastActivity = now();
    session.shell.write(data);
  }

  function resize(sessionId, employeeId, jobId, cols, rows) {
    const session = lookup(sessionId, employeeId, jobId);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 200)
      throw new WebTerminalError("Invalid terminal size");
    session.lastActivity = now();
    session.shell.resize(cols, rows);
  }

  function close(sessionId, employeeId, jobId, reason = "client_closed") {
    closeSession(lookup(sessionId, employeeId, jobId), reason);
  }

  function session(sessionId, employeeId, jobId) {
    const found = lookup(sessionId, employeeId, jobId);
    return { projectId: found.projectId, jobId: found.jobId };
  }

  function closeJob(jobId, reason = "environment_stopped") {
    for (const item of [...sessions.values()]) if (item.jobId === jobId) closeSession(item, reason);
  }

  function sweep() {
    const at = now();
    for (const item of [...sessions.values()]) {
      if (!item.opened) continue;
      let job;
      try { job = jobRow(item.jobId); } catch { job = null; }
      if (!job || job.state !== "ready" || job.stop_requested_at) closeSession(item, "environment_stopped");
      else if (item.deadline !== null && at >= item.deadline) closeSession(item, "environment_expired");
      else if (at - item.lastActivity >= idleTimeoutMs) closeSession(item, "idle_timeout");
    }
  }

  const unsubscribe = subscribeStop((jobId) => closeJob(jobId, "environment_stopped"));
  const timer = sweepMs > 0 ? setInterval(sweep, sweepMs) : null;
  timer?.unref?.();

  return {
    open, attach, input, resize, close, session, closeJob, sweep,
    get size() { return sessions.size; },
    dispose() {
      if (timer) clearInterval(timer);
      try { unsubscribe?.(); } catch { /* Best effort. */ }
      for (const item of [...sessions.values()]) closeSession(item, "server_shutdown");
    },
  };
}
