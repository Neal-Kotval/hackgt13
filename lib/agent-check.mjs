// Agent readiness evidence and teardown cleanup log (HAC-121).
//
// SSH readiness (run_box_job.state = ready) and agent readiness are separate
// facts. A worker records `run_box_agent_check` only from the output of
// `codex --version` run as the non-root agentcloud account inside the
// environment; the check is ok only for the exact pinned version.
// `run_box_cleanup_log` records the best-effort credential and scratch cleanup
// that runs before an environment is removed. No command output that could hold
// a credential is stored: only step names, a boolean, and a bounded reason.

export const CODEX_VERSION = "0.157.1";
export const AGENTS = Object.freeze(["codex"]);
export const SANDBOX_HOME = "/home/agentcloud";

// Each step prints one marker line; the whole script never fails, so a broken
// step cannot stop the steps after it or the removal that follows.
export const CLEANUP_STEPS = Object.freeze([
  ["codex-logout", "codex logout || true"],
  ["remove-codex-auth", "rm -f \"$HOME/.codex/auth.json\""],
  ["remove-scratch", "rm -rf /tmp/agentcloud-* \"$HOME/.cache/agentcloud\""],
  ["verify-auth-absent", "test ! -e \"$HOME/.codex/auth.json\""],
]);
export const CLEANUP_SCRIPT = [
  "export HOME=\"${HOME:-/home/agentcloud}\"",
  ...CLEANUP_STEPS.map(([step, command]) =>
    `if ( ${command} ) >/dev/null 2>&1; then echo "AGENTCLOUD_CLEANUP ${step} ok"; else echo "AGENTCLOUD_CLEANUP ${step} fail"; fi`),
  "exit 0",
  "",
].join("\n");

// Prints the Codex version (base64, so arbitrary output cannot break the
// evidence line) and whether tmux is available.
// Safe under `set -euo pipefail` (bash).
export const AGENT_CHECK_SCRIPT = `codex_rc=0
codex_out=$(codex --version 2>&1) || codex_rc=$?
codex_out="\${codex_out:0:512}"
printf 'AGENTCLOUD_CODEX=%s:%s\\n' "$codex_rc" "$(printf '%s' "$codex_out" | base64 | tr -d '\\n')"
if command -v tmux >/dev/null 2>&1; then echo 'AGENTCLOUD_TMUX=1'; else echo 'AGENTCLOUD_TMUX=0'; fi
`;

function bounded(value, limit = 256) {
  return value === null || value === undefined ? null : String(value).slice(0, limit);
}

export function migrateAgentCheck(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS run_box_agent_check (
    job_id TEXT NOT NULL,
    agent TEXT NOT NULL CHECK(agent IN ('codex')),
    version TEXT,
    checked_at TEXT NOT NULL,
    ok INTEGER NOT NULL CHECK(ok IN (0, 1)),
    reason TEXT,
    PRIMARY KEY (job_id, agent)
  );
  CREATE TABLE IF NOT EXISTS run_box_cleanup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    step TEXT NOT NULL,
    ok INTEGER NOT NULL CHECK(ok IN (0, 1)),
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_box_cleanup_log_job ON run_box_cleanup_log(job_id, id);
  CREATE TABLE IF NOT EXISTS run_box_workspace (
    job_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );`);
}

// Parses the AGENT_CHECK_SCRIPT output. Returns { ok, version, reason, tmux }.
export function evaluateAgentCheckOutput(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const codexLines = text.split("\n").filter((line) => line.startsWith("AGENTCLOUD_CODEX="));
  const tmuxLine = text.split("\n").find((line) => line.startsWith("AGENTCLOUD_TMUX="));
  const tmux = tmuxLine ? tmuxLine.trim() === "AGENTCLOUD_TMUX=1" : null;
  if (codexLines.length !== 1) return { ok: false, version: null, reason: "Codex version check did not run", tmux };
  const match = /^AGENTCLOUD_CODEX=(\d+):([A-Za-z0-9+/=]*)$/.exec(codexLines[0].trim());
  if (!match) return { ok: false, version: null, reason: "Codex version output is malformed", tmux };
  const code = Number(match[1]);
  const output = Buffer.from(match[2], "base64").toString("utf8").trim();
  if (code === 127) return { ok: false, version: null, reason: "Codex is not installed on PATH", tmux };
  const version = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(output.split("\n")[0] || "")?.[1] || null;
  if (code !== 0 || !version) return { ok: false, version, reason: `codex --version failed (exit ${code})`, tmux };
  if (version !== CODEX_VERSION)
    return { ok: false, version, reason: `Codex ${version} is installed; ${CODEX_VERSION} is required`, tmux };
  return { ok: true, version, reason: null, tmux };
}

export function recordAgentCheck(db, jobId, { agent = "codex", version = null, ok, reason = null, at = new Date() }) {
  if (typeof jobId !== "string" || !jobId) throw new Error("Invalid job ID");
  if (!AGENTS.includes(agent)) throw new Error("Unsupported agent");
  if (typeof ok !== "boolean") throw new Error("Agent check outcome is required");
  if (version !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid agent version");
  db.prepare(`INSERT INTO run_box_agent_check (job_id, agent, version, checked_at, ok, reason)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, agent) DO UPDATE SET version = excluded.version, checked_at = excluded.checked_at,
      ok = excluded.ok, reason = excluded.reason`)
    .run(jobId, agent, version, at.toISOString(), ok ? 1 : 0, ok ? null : bounded(reason || "Agent check failed"));
}

// API shape: { state: "pending" | "ready" | "failed", version, reason }.
export function getAgentCheck(db, jobId, agent = "codex") {
  const row = db.prepare("SELECT * FROM run_box_agent_check WHERE job_id = ? AND agent = ?").get(jobId, agent);
  if (!row) return { state: "pending", version: null, reason: null, checkedAt: null };
  return { state: row.ok ? "ready" : "failed", version: row.version, reason: row.reason, checkedAt: row.checked_at };
}

export function recordCleanupStep(db, jobId, step, ok, at = new Date()) {
  if (typeof jobId !== "string" || !jobId) throw new Error("Invalid job ID");
  if (typeof step !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(step)) throw new Error("Invalid cleanup step");
  db.prepare("INSERT INTO run_box_cleanup_log (job_id, step, ok, at) VALUES (?, ?, ?, ?)")
    .run(jobId, step, ok ? 1 : 0, at.toISOString());
}

export function listCleanupSteps(db, jobId) {
  return db.prepare("SELECT step, ok, at FROM run_box_cleanup_log WHERE job_id = ? ORDER BY id").all(jobId)
    .map((row) => ({ step: row.step, ok: row.ok === 1, at: row.at }));
}

export function parseCleanupOutput(stdout) {
  const known = new Set(CLEANUP_STEPS.map(([step]) => step));
  const results = new Map();
  for (const line of String(stdout || "").split("\n")) {
    const match = /^AGENTCLOUD_CLEANUP ([a-z-]+) (ok|fail)$/.exec(line.trim());
    if (match && known.has(match[1]) && !results.has(match[1])) results.set(match[1], match[2] === "ok");
  }
  return CLEANUP_STEPS.map(([step]) => ({ step, ok: results.get(step) ?? false, ran: results.has(step) }));
}

// Runs the cleanup through `execute(script) -> { code, stdout }` and records
// each step. Never throws: cleanup failures must not block teardown.
export async function runAgentCleanup(db, jobId, execute) {
  let result;
  try { result = await execute(CLEANUP_SCRIPT); }
  catch { result = null; }
  const steps = result ? parseCleanupOutput(result.stdout) : [];
  const reached = result !== null && steps.some((item) => item.ran);
  if (jobId) {
    try {
      recordCleanupStep(db, jobId, "cleanup-exec", reached);
      for (const item of steps) if (item.ran) recordCleanupStep(db, jobId, item.step, item.ok);
    } catch { /* Logging is best effort as well. */ }
  }
  return { reached, steps: steps.filter((item) => item.ran).map(({ step, ok }) => ({ step, ok })) };
}

export function recordWorkspacePath(db, jobId, workspacePath) {
  if (typeof workspacePath !== "string" || !workspacePath.startsWith(`${SANDBOX_HOME}/`) ||
      workspacePath.length > 512 || /(^|\/)\.\.?(\/|$)|[\0\n]/.test(workspacePath))
    throw new Error("Invalid workspace path");
  db.prepare(`INSERT INTO run_box_workspace (job_id, path, recorded_at) VALUES (?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET path = excluded.path, recorded_at = excluded.recorded_at`)
    .run(jobId, workspacePath, new Date().toISOString());
}

export function getWorkspacePath(db, jobId) {
  return db.prepare("SELECT path FROM run_box_workspace WHERE job_id = ?").get(jobId)?.path ?? null;
}
