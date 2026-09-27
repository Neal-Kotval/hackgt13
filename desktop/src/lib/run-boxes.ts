/**
 * Run-box (environment) listing shapes for the desktop Environments view (HAC-90).
 * Pure helpers shared by the main process (parsing) and renderer (labels).
 * See docs/sandbox-mvp-contract.md.
 */

export type RunBoxState =
  | "queued"
  | "allocating"
  | "connecting"
  | "verifying"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export type RunBoxSummary = {
  id: string;
  projectId: string;
  provider: string;
  profileId: string | null;
  state: RunBoxState | "unknown";
  rawState: string;
  ssh: { host: string; port: number; username: string } | null;
  access: string;
  maxDurationMinutes: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  stopRequested: boolean;
  /** Stage 2 `agent.codex` check; null when the server does not report it. */
  codex: RunBoxCodexCheck | null;
};

export type RunBoxCodexCheck = {
  state: "pending" | "ready" | "failed" | "unknown";
  reason: string | null;
};

const STATES: readonly RunBoxState[] = [
  "queued",
  "allocating",
  "connecting",
  "verifying",
  "ready",
  "stopping",
  "stopped",
  "failed",
];

const TRANSITIONAL: ReadonlySet<string> = new Set([
  "queued",
  "allocating",
  "connecting",
  "verifying",
  "stopping",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseSsh(value: unknown): RunBoxSummary["ssh"] {
  const record = asRecord(value);
  if (!record) return null;
  const host = text(record.host);
  const username = text(record.username);
  const port = typeof record.port === "number" ? record.port : Number(record.port);
  if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port, username };
}

function parseCodexCheck(value: unknown): RunBoxCodexCheck | null {
  const codex = asRecord(asRecord(value)?.codex);
  if (!codex) return null;
  const raw = text(codex.state);
  const state = raw === "pending" || raw === "ready" || raw === "failed" ? raw : "unknown";
  return { state, reason: text(codex.reason) };
}

/** Normalize one GET /api/run-boxes job (camelCase contract or raw snake_case row). */
export function parseRunBox(value: unknown): RunBoxSummary | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = text(record.id);
  if (!id) return null;
  const rawState = text(record.state) ?? "unknown";
  const state = (STATES as readonly string[]).includes(rawState)
    ? (rawState as RunBoxState)
    : "unknown";
  const duration = pick(record, "maxDurationMinutes", "max_duration_minutes");
  return {
    id,
    projectId: text(pick(record, "projectId", "project_id")) ?? "",
    provider: text(record.provider) ?? "unknown",
    profileId: text(pick(record, "profileId", "profile_id")),
    state,
    rawState,
    ssh: parseSsh(record.ssh),
    access: text(record.access) ?? "trusted-shell",
    maxDurationMinutes: typeof duration === "number" ? duration : null,
    createdAt: text(pick(record, "createdAt", "created_at")),
    updatedAt: text(pick(record, "updatedAt", "updated_at")),
    stopRequested: Boolean(pick(record, "stopRequestedAt", "stop_requested_at")),
    codex: parseCodexCheck(record.agent),
  };
}

export function parseRunBoxList(payload: unknown): RunBoxSummary[] {
  const record = asRecord(payload);
  const jobs = record && Array.isArray(record.jobs) ? record.jobs : null;
  if (!jobs) throw new Error("Unexpected /api/run-boxes response — expected jobs.");
  return jobs
    .map(parseRunBox)
    .filter((job): job is RunBoxSummary => Boolean(job));
}

/** Terminal may open only when the server says ready and published SSH details. */
export function canOpenTerminal(job: RunBoxSummary): boolean {
  return job.state === "ready" && job.ssh !== null && !job.stopRequested;
}

export function isTransitional(job: RunBoxSummary): boolean {
  return TRANSITIONAL.has(job.rawState);
}

export function runBoxStateLabel(job: RunBoxSummary): string {
  switch (job.state) {
    case "queued":
      return "Queued";
    case "allocating":
      return "Allocating";
    case "connecting":
      return "Connecting";
    case "verifying":
      return "Verifying SSH";
    case "ready":
      return job.stopRequested ? "Stop requested" : "Ready";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    default:
      return `Unknown (${job.rawState})`;
  }
}

export function runBoxStateTone(job: RunBoxSummary): "green" | "cyan" | "pink" | "yellow" {
  if (job.state === "ready" && !job.stopRequested) return "green";
  if (job.state === "failed") return "pink";
  if (job.state === "stopped" || job.state === "unknown") return "yellow";
  return "cyan";
}

/** Why "Open terminal" is disabled, or null when it is enabled. */
export function terminalBlockedReason(job: RunBoxSummary): string | null {
  if (job.stopRequested) return "Stop was requested for this environment.";
  if (job.state !== "ready") {
    return `Terminal opens once the environment is ready (currently ${runBoxStateLabel(job).toLowerCase()}).`;
  }
  if (!job.ssh) return "The server has not published SSH access for this environment.";
  return null;
}

/** Codex can be targeted from Project chat only when both SSH and the agent check are ready. */
export function canTargetCodex(job: RunBoxSummary): boolean {
  return job.state === "ready" && !job.stopRequested && job.codex?.state === "ready";
}

/** Why Codex cannot target this environment, or null when it can. */
export function codexBlockedReason(job: RunBoxSummary): string | null {
  if (job.stopRequested) return "Stop was requested for this environment.";
  if (job.state !== "ready") {
    return `Codex opens once the environment is ready (currently ${runBoxStateLabel(job).toLowerCase()}).`;
  }
  if (!job.codex) return "The server has not reported a Codex check for this environment.";
  if (job.codex.state === "pending") return "Codex is still being checked on this environment.";
  if (job.codex.state !== "ready") {
    return job.codex.reason ? `Codex is unavailable: ${job.codex.reason}` : "Codex is unavailable on this environment.";
  }
  return null;
}
