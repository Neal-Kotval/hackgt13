/**
 * Project chat Codex targets (HAC-153). Pure helpers: which targets the picker
 * offers, how a session's target is read from the API, and their labels.
 * See docs/stage3-contract.md ("Desktop (Project chat)").
 */
import { canTargetCodex, type RunBoxSummary } from "./run-boxes.ts";

export type CodexSessionStatus = "initializing" | "auth_required" | "ready" | "running" | "error" | "stopped";

/** `target` from GET /api/codex-sessions. Older servers omit it: that means local. */
export type CodexSessionTarget =
  | { kind: "local" }
  | { kind: "runBox"; runBoxId: string; provider: string | null; profileId: string | null; state: string | null };

export type CodexSession = {
  id: string;
  projectId: string;
  agentId: string;
  status: CodexSessionStatus;
  error: string | null;
  target: CodexSessionTarget;
};

/** Picker option. `key` is "local" or "runBox:<id>". */
export type ChatTarget =
  | { key: "local"; kind: "local"; label: string }
  | { key: string; kind: "runBox"; runBoxId: string; label: string; available: boolean };

export const LOCAL_TARGET_KEY = "local";
export const LOCAL_TARGET_LABEL = "Local Codex box";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseSessionTarget(value: unknown): CodexSessionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "local" };
  const record = value as Record<string, unknown>;
  const runBoxId = text(record.runBoxId);
  if (record.kind !== "runBox" || !runBoxId) return { kind: "local" };
  return {
    kind: "runBox",
    runBoxId,
    provider: text(record.provider),
    profileId: text(record.profileId),
    state: text(record.state),
  };
}

const STATUSES: readonly CodexSessionStatus[] = ["initializing", "auth_required", "ready", "running", "error", "stopped"];

/** Normalize one session from the API, tolerating the pre-Stage 3 shape. */
export function parseCodexSession(value: unknown): CodexSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = text(record.id);
  if (!id) return null;
  const status = STATUSES.includes(record.status as CodexSessionStatus) ? (record.status as CodexSessionStatus) : "error";
  return {
    id,
    projectId: text(record.projectId) ?? "",
    agentId: text(record.agentId) ?? "",
    status,
    error: typeof record.error === "string" ? record.error : null,
    target: parseSessionTarget(record.target),
  };
}

export function parseCodexSessions(value: unknown): CodexSession[] {
  return Array.isArray(value)
    ? value.map(parseCodexSession).filter((session): session is CodexSession => Boolean(session))
    : [];
}

export function targetKey(target: CodexSessionTarget): string {
  return target.kind === "local" ? LOCAL_TARGET_KEY : `runBox:${target.runBoxId}`;
}

const PROFILE_LABELS: Record<string, string> = {
  "aws-cpu": "AWS EC2 CPU",
  "g6-l4-small": "AWS EC2 GPU",
  "local-docker-sandbox": "Local Docker sandbox",
  "runpod-rtx-4090": "Runpod RTX 4090",
  "runpod-budget-gpu": "Runpod GPU",
};
const PROVIDER_LABELS: Record<string, string> = {
  "aws-ec2": "AWS EC2",
  "docker-local": "Local Docker sandbox",
  runpod: "Runpod",
};

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** "AWS EC2 CPU · 1a2b3c4d": profile label when known, else provider (and profile). */
export function environmentLabel(runBoxId: string, provider: string | null, profileId: string | null): string {
  const named = (profileId && PROFILE_LABELS[profileId]) || null;
  const base = named
    ?? [provider ? PROVIDER_LABELS[provider] ?? provider : "Environment", profileId].filter(Boolean).join(" ");
  return `${base} · ${shortId(runBoxId)}`;
}

export function sessionTargetLabel(target: CodexSessionTarget): string {
  return target.kind === "local" ? LOCAL_TARGET_LABEL : environmentLabel(target.runBoxId, target.provider, target.profileId);
}

/**
 * Picker options: the local box, then each ready environment of the project
 * whose Codex check is ready. A current session's environment that is no
 * longer ready stays listed (unavailable) so the picker never shows a blank.
 */
export function deriveChatTargets(projectId: string, runBoxes: RunBoxSummary[], current?: CodexSessionTarget | null): ChatTarget[] {
  const targets: ChatTarget[] = [{ key: LOCAL_TARGET_KEY, kind: "local", label: LOCAL_TARGET_LABEL }];
  for (const job of runBoxes) {
    if (job.projectId && job.projectId !== projectId) continue;
    if (!canTargetCodex(job)) continue;
    targets.push({ key: `runBox:${job.id}`, kind: "runBox", runBoxId: job.id, label: environmentLabel(job.id, job.provider, job.profileId), available: true });
  }
  if (current?.kind === "runBox" && !targets.some(target => target.key === targetKey(current))) {
    targets.push({ key: targetKey(current), kind: "runBox", runBoxId: current.runBoxId, label: `${sessionTargetLabel(current)} (unavailable)`, available: false });
  }
  return targets;
}

/** Session for a picker key: local picks the first local session (legacy servers: all are local). */
export function sessionForTarget(sessions: CodexSession[], key: string): CodexSession | undefined {
  return sessions.find(session => targetKey(session.target) === key);
}
