import { randomUUID } from "node:crypto";

// Agent runs reported by the desktop Codex panel (HAC-122) for a ready
// environment. A run row records who started which agent in which
// environment; its events are the reported output, appended idempotently by
// sequence number. These rows are reports from the employee's desktop client,
// not independent proof of execution on the box.

export const AGENTS = new Set(["codex"]);
export const RUN_STATUSES = new Set(["running", "succeeded", "failed", "cancelled"]);
export const FINISH_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export const EVENT_KINDS = new Set([
  "message", "reasoning", "command.start", "command.output", "command.exit",
  "file.change", "error", "terminal.command", "status",
]);
export const EVENT_ACTORS = new Set(["codex", "employee"]);
export const MAX_PROMPT = 4000;
export const MAX_TEXT = 8192;
export const MAX_EVENTS_PER_CALL = 200;
export const MAX_EVENTS_PER_READ = 1000;
export const MAX_RUNS_PER_LIST = 200;
export const TRUNCATION_MARKER = "\n… [truncated by AgentCloud]";

export class AgentRunError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function migrateAgentRuns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_run (
      id TEXT PRIMARY KEY,
      run_box_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      agent TEXT NOT NULL CHECK(agent IN ('codex')),
      prompt TEXT NOT NULL CHECK(length(prompt) <= ${MAX_PROMPT}),
      status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      exit_code INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_run_project ON agent_run(project_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS agent_run_event (
      run_id TEXT NOT NULL REFERENCES agent_run(id),
      seq INTEGER NOT NULL CHECK(seq >= 0),
      kind TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('codex', 'employee')),
      text TEXT CHECK(text IS NULL OR length(text) <= ${MAX_TEXT}),
      command TEXT CHECK(command IS NULL OR length(command) <= ${MAX_TEXT}),
      exit_code INTEGER,
      at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
}

function identifier(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new AgentRunError(`Invalid ${name}`);
  return value;
}

// Bound free text to MAX_TEXT characters, marking truncation inside the bound.
export function boundText(value, name = "text") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AgentRunError(`Invalid event ${name}`);
  if (value.length <= MAX_TEXT) return value;
  return value.slice(0, MAX_TEXT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function exitCode(value, name = "exit code") {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    throw new AgentRunError(`Invalid ${name}`);
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || value.length > 64) throw new AgentRunError("Invalid event time");
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new AgentRunError("Invalid event time");
  return date.toISOString();
}

function publicRun(row) {
  return {
    id: row.id,
    runBoxId: row.run_box_id,
    projectId: row.project_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name ?? null,
    agent: row.agent,
    prompt: row.prompt,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    environment: row.run_box_provider
      ? { provider: row.run_box_provider, profileId: row.run_box_profile_id, state: row.run_box_state }
      : null,
    eventCount: row.event_count ?? 0,
  };
}

function publicEvent(row) {
  return {
    seq: row.seq,
    kind: row.kind,
    actor: row.actor,
    text: row.text,
    command: row.command,
    exitCode: row.exit_code,
    at: row.at,
  };
}

const runSelect = `SELECT r.*, u.name AS employee_name,
    j.provider AS run_box_provider, j.profile_id AS run_box_profile_id, j.state AS run_box_state,
    (SELECT COUNT(*) FROM agent_run_event e WHERE e.run_id = r.id) AS event_count
  FROM agent_run r
  LEFT JOIN user u ON u.id = r.employee_id
  LEFT JOIN run_box_job j ON j.id = r.run_box_id`;

function runRow(db, id) {
  return db.prepare(`${runSelect} WHERE r.id = ?`).get(id) || null;
}

export function getAgentRunRow(db, id) {
  return db.prepare("SELECT * FROM agent_run WHERE id = ?").get(identifier(id, "run ID")) || null;
}

// Caller has already verified the employee and their membership in the box's
// project. The run box row is authoritative for project and readiness.
export function createAgentRun(db, { runBox, employeeId, agent, prompt, now = new Date() }) {
  if (!runBox) throw new AgentRunError("Environment not found", 404);
  if (runBox.state !== "ready") throw new AgentRunError("Environment is not ready", 409);
  if (typeof agent !== "string" || !AGENTS.has(agent)) throw new AgentRunError("Unsupported agent");
  if (typeof prompt !== "string" || !prompt.trim()) throw new AgentRunError("Prompt is required");
  if (prompt.length > MAX_PROMPT) throw new AgentRunError(`Prompt exceeds ${MAX_PROMPT} characters`);
  const row = {
    id: randomUUID(),
    run_box_id: runBox.id,
    project_id: runBox.project_id,
    employee_id: identifier(employeeId, "employee ID"),
    agent,
    prompt,
    status: "running",
    started_at: now.toISOString(),
  };
  db.prepare(`INSERT INTO agent_run (id, run_box_id, project_id, employee_id, agent, prompt, status, started_at)
    VALUES (@id, @run_box_id, @project_id, @employee_id, @agent, @prompt, @status, @started_at)`).run(row);
  return publicRun(runRow(db, row.id));
}

export function validateEvents(input) {
  if (!Array.isArray(input) || input.length === 0) throw new AgentRunError("Expected a non-empty events array");
  if (input.length > MAX_EVENTS_PER_CALL)
    throw new AgentRunError(`At most ${MAX_EVENTS_PER_CALL} events per request`, 413);
  return input.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new AgentRunError("Invalid event");
    for (const key of Object.keys(event))
      if (!["seq", "kind", "actor", "text", "command", "exitCode", "at"].includes(key))
        throw new AgentRunError(`Unsupported event field: ${key}`);
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new AgentRunError("Invalid event seq");
    if (typeof event.kind !== "string" || !EVENT_KINDS.has(event.kind)) throw new AgentRunError("Invalid event kind");
    if (typeof event.actor !== "string" || !EVENT_ACTORS.has(event.actor)) throw new AgentRunError("Invalid event actor");
    return {
      seq: event.seq,
      kind: event.kind,
      actor: event.actor,
      text: boundText(event.text),
      command: boundText(event.command, "command"),
      exit_code: exitCode(event.exitCode, "event exit code"),
      at: timestamp(event.at),
    };
  });
}

function requireRunOwner(run, employeeId) {
  if (!run) throw new AgentRunError("Run not found", 404);
  if (run.employee_id !== employeeId)
    throw new AgentRunError("Only the employee who started this run may report it", 403);
}

// Idempotent by (run_id, seq): a retried or repeated seq is counted as a
// duplicate and never overwrites the first report.
export function appendAgentRunEvents(db, { runId, employeeId, events }) {
  const run = getAgentRunRow(db, runId);
  requireRunOwner(run, employeeId);
  const rows = validateEvents(events);
  const insert = db.prepare(`INSERT OR IGNORE INTO agent_run_event (run_id, seq, kind, actor, text, command, exit_code, at)
    VALUES (@run_id, @seq, @kind, @actor, @text, @command, @exit_code, @at)`);
  let accepted = 0;
  db.transaction(() => {
    for (const row of rows) accepted += insert.run({ ...row, run_id: run.id }).changes;
  })();
  return { accepted, duplicates: rows.length - accepted };
}

export function finishAgentRun(db, { runId, employeeId, status, exitCode: code, now = new Date() }) {
  const run = getAgentRunRow(db, runId);
  requireRunOwner(run, employeeId);
  if (typeof status !== "string" || !FINISH_STATUSES.has(status)) throw new AgentRunError("Invalid run status");
  const exit = exitCode(code);
  if (run.status !== "running") {
    // A retried finish with the same outcome is idempotent; a different outcome conflicts.
    if (run.status === status && (code === undefined || run.exit_code === exit)) return publicRun(runRow(db, run.id));
    throw new AgentRunError("Run is already finished", 409);
  }
  db.prepare(`UPDATE agent_run SET status = ?, exit_code = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
    .run(status, exit, now.toISOString(), run.id);
  return publicRun(runRow(db, run.id));
}

export function listAgentRuns(db, projectId) {
  return db.prepare(`${runSelect} WHERE r.project_id = ?
    ORDER BY r.started_at DESC, r.rowid DESC LIMIT ${MAX_RUNS_PER_LIST}`)
    .all(identifier(projectId, "project ID")).map(publicRun);
}

// Events ordered by seq. `afterSeq` lets a live view fetch only new events.
export function getAgentRun(db, runId, { afterSeq = -1 } = {}) {
  const row = runRow(db, identifier(runId, "run ID"));
  if (!row) return null;
  const events = db.prepare(`SELECT * FROM agent_run_event WHERE run_id = ? AND seq > ?
    ORDER BY seq ASC LIMIT ${MAX_EVENTS_PER_READ + 1}`).all(row.id, afterSeq).map(publicEvent);
  const hasMore = events.length > MAX_EVENTS_PER_READ;
  return { run: publicRun(row), events: hasMore ? events.slice(0, MAX_EVENTS_PER_READ) : events, hasMore };
}
