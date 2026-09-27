/**
 * Records Codex runs through the Stage 2 agent-runs API (HAC-122 → HAC-124).
 * Main process only; requests use the employee session via `request`.
 *
 *   POST /api/agent-runs              { runBoxId, agent: "codex", prompt } -> 201 { run }
 *   POST /api/agent-runs/:id/events   { events: [...] } (≤ 200 per call, idempotent by seq)
 *   POST /api/agent-runs/:id/finish   { status, exitCode? }
 *
 * If the server does not have these routes (404/405/501) or is unreachable,
 * the run still proceeds locally and the panel shows "not recorded".
 */
import type { CodexRunEventRecord, CodexRunStatus } from "../src/lib/codex-types.ts";

export type HumanRequest = (path: string, init?: RequestInit) => Promise<Response>;

export const MAX_PROMPT_CHARS = 4000;
export const MAX_EVENTS_PER_POST = 200;
const UNSUPPORTED = new Set([404, 405, 501]);

export class RunStartRejected extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RunStartRejected";
    this.status = status;
  }
}

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error.slice(0, 300);
  } catch {
    // not JSON
  }
  return "";
}

export type RecorderOptions = {
  request: HumanRequest;
  flushIntervalMs?: number;
  /** Called once when recording stops working mid-run. */
  onUnrecorded?: (note: string) => void;
};

export class RunRecorder {
  runId: string | null = null;
  recorded = false;
  note: string | undefined;
  private readonly request: HumanRequest;
  private readonly flushIntervalMs: number;
  private readonly onUnrecorded?: (note: string) => void;
  private queue: CodexRunEventRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(options: RecorderOptions) {
    this.request = options.request;
    this.flushIntervalMs = options.flushIntervalMs ?? 400;
    this.onUnrecorded = options.onUnrecorded;
  }

  /**
   * Create the agent_run. Throws RunStartRejected for 401/403/409 (the server
   * refused this run); returns normally with `recorded=false` when the server
   * lacks the route or cannot be reached.
   */
  async start(runBoxId: string, prompt: string): Promise<void> {
    let response: Response;
    try {
      response = await this.request("/api/agent-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runBoxId,
          agent: "codex",
          prompt: prompt.slice(0, MAX_PROMPT_CHARS),
        }),
      });
    } catch {
      this.markUnrecorded("Not recorded: AgentCloud could not be reached.");
      return;
    }
    const body = await response.text();
    if (UNSUPPORTED.has(response.status)) {
      this.markUnrecorded("Not recorded: this AgentCloud server does not record agent runs yet.");
      return;
    }
    if (response.status === 401) {
      throw new RunStartRejected("Employee sign-in required. Sign in again, then retry.", 401);
    }
    if (response.status === 403 || response.status === 409) {
      throw new RunStartRejected(
        errorText(body) ||
          (response.status === 409
            ? "The environment is not ready for an agent run."
            : "You do not have access to this environment."),
        response.status,
      );
    }
    if (!response.ok) {
      this.markUnrecorded(`Not recorded: the server returned ${response.status}.`);
      return;
    }
    let id: unknown;
    try {
      const parsed = JSON.parse(body) as { run?: { id?: unknown }; id?: unknown };
      id = parsed.run?.id ?? parsed.id;
    } catch {
      id = null;
    }
    if (typeof id !== "string" || !id) {
      this.markUnrecorded("Not recorded: unexpected response when creating the run.");
      return;
    }
    this.runId = id;
    this.recorded = true;
  }

  private markUnrecorded(note: string): void {
    const wasRecorded = this.recorded;
    this.recorded = false;
    if (!this.note) this.note = note;
    this.queue = [];
    if (wasRecorded) this.onUnrecorded?.(note);
  }

  push(event: CodexRunEventRecord): void {
    if (!this.recorded) return;
    this.queue.push(event);
    if (this.queue.length >= MAX_EVENTS_PER_POST) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  /** Serialize flushes so seq order is preserved across posts. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow());
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.recorded && this.runId && this.queue.length > 0) {
      const batch = this.queue.slice(0, MAX_EVENTS_PER_POST);
      const ok = await this.postEvents(batch);
      if (!ok) return;
      this.queue = this.queue.slice(batch.length);
    }
  }

  private async postEvents(batch: CodexRunEventRecord[]): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.request(
          `/api/agent-runs/${encodeURIComponent(this.runId ?? "")}/events`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ events: batch }),
          },
        );
        await response.text();
        if (response.ok) return true;
        if (UNSUPPORTED.has(response.status) || response.status === 403) {
          this.markUnrecorded(`Not recorded: the server stopped accepting events (${response.status}).`);
          return false;
        }
      } catch {
        // retry once
      }
    }
    this.markUnrecorded("Not recorded: events could not be delivered.");
    return false;
  }

  async finish(status: CodexRunStatus, exitCode: number | null): Promise<void> {
    await this.flush();
    if (!this.recorded || !this.runId) return;
    try {
      const response = await this.request(
        `/api/agent-runs/${encodeURIComponent(this.runId)}/finish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(exitCode === null ? { status } : { status, exitCode }),
        },
      );
      await response.text();
      if (!response.ok) this.markUnrecorded(`Not recorded: finishing the run failed (${response.status}).`);
    } catch {
      this.markUnrecorded("Not recorded: finishing the run failed.");
    }
  }
}
