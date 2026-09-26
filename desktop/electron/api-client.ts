/**
 * Main-process loopback client for AgentCloud human APIs.
 * Uses Node fetch (no browser Origin) so mutations pass same-origin checks
 * when Origin is set to the configured AGENTCLOUD_URL.
 * Session cookies are supplied by the auth client (HAC-24) — never logged.
 */

export type HumanRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export type ProjectAgentSnapshot = {
  id: string;
  name: string;
  role: string;
  status: string;
  lastSeen?: string;
};

export type ProjectTaskSnapshot = {
  id: string;
  title: string;
  owner: string;
  status: string;
};

export type ProjectResourceSnapshot = {
  id: string;
  name: string;
  kind: string;
  status: string;
};

export type ProjectRequestSnapshot = {
  id: string;
  purpose: string;
  status: string;
  decisionStatus: string;
  decisionReason: string;
};

export type ProjectSnapshot = {
  id: string;
  name: string;
  repo: string;
  template: string;
  compute: string;
  host?: string;
  agents: ProjectAgentSnapshot[];
  tasks: ProjectTaskSnapshot[];
  resources: ProjectResourceSnapshot[];
  resourceRequests: ProjectRequestSnapshot[];
};

export type AgentCloudStateSummary = {
  revision: number;
  projectCount: number;
  projects: ProjectSnapshot[];
};

export class LoopbackApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LoopbackApiError";
    this.status = status;
  }
}

export function normalizeBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  return trimmed || "http://127.0.0.1:3000";
}

export function joinApiUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (/^https?:\/\//i.test(path)) return path;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Map HTTP failures to short UI-facing strings. Never include cookies/tokens. */
export function mapApiFailure(
  status: number,
  bodyText: string,
  baseUrl: string,
): string {
  let serverMessage = "";
  try {
    const parsed = JSON.parse(bodyText) as { error?: string; message?: string };
    serverMessage = parsed.error || parsed.message || "";
  } catch {
    // ignore non-JSON
  }

  if (status === 401) {
    return "Employee sign-in required. Sign in again, then retry.";
  }
  if (status === 403) {
    return serverMessage || "Forbidden. Check project membership or email verification.";
  }
  if (status === 404) {
    return `AgentCloud API not found at ${baseUrl}. Is the web app running (just / just dev)?`;
  }
  if (status >= 500) {
    return serverMessage || `AgentCloud server error (${status}) at ${baseUrl}.`;
  }
  return (
    serverMessage ||
    `Request failed (${status}). Confirm the web app is running at ${baseUrl}.`
  );
}

export function serverUnreachableMessage(baseUrl: string): string {
  return `Cannot reach AgentCloud at ${baseUrl}. Start the web app with just (or just dev), then retry.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function mapProject(value: unknown): ProjectSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = stringField(record, "id");
  const name = stringField(record, "name");
  if (!id || !name) return null;

  const agents = Array.isArray(record.agents)
    ? record.agents
        .map((agent) => {
          const row = asRecord(agent);
          if (!row) return null;
          const agentId = stringField(row, "id");
          const agentName = stringField(row, "name");
          if (!agentId || !agentName) return null;
          const lastSeen = stringField(row, "lastSeen");
          return {
            id: agentId,
            name: agentName,
            role: stringField(row, "role", "unknown"),
            status: stringField(row, "status", "unknown"),
            ...(lastSeen ? { lastSeen } : {}),
          } satisfies ProjectAgentSnapshot;
        })
        .filter((agent): agent is ProjectAgentSnapshot => Boolean(agent))
    : [];

  const tasks = Array.isArray(record.tasks)
    ? record.tasks
        .map((task) => {
          const row = asRecord(task);
          if (!row) return null;
          const taskId = stringField(row, "id");
          const title = stringField(row, "title");
          if (!taskId || !title) return null;
          return {
            id: taskId,
            title,
            owner: stringField(row, "owner", "unknown"),
            status: stringField(row, "status", "unknown"),
          } satisfies ProjectTaskSnapshot;
        })
        .filter((task): task is ProjectTaskSnapshot => Boolean(task))
    : [];

  const resources = Array.isArray(record.resources)
    ? record.resources
        .map((resource) => {
          const row = asRecord(resource);
          if (!row) return null;
          const resourceId = stringField(row, "id");
          const resourceName = stringField(row, "name");
          if (!resourceId || !resourceName) return null;
          return {
            id: resourceId,
            name: resourceName,
            kind: stringField(row, "kind", "unknown"),
            status: stringField(row, "status", "unknown"),
          } satisfies ProjectResourceSnapshot;
        })
        .filter((resource): resource is ProjectResourceSnapshot =>
          Boolean(resource),
        )
    : [];

  const resourceRequests = Array.isArray(record.resourceRequests)
    ? record.resourceRequests
        .map((request) => {
          const row = asRecord(request);
          if (!row) return null;
          const requestId = stringField(row, "id");
          if (!requestId) return null;
          const decision = asRecord(row.decision) || {};
          return {
            id: requestId,
            purpose: stringField(row, "purpose", "(no purpose)"),
            status: stringField(row, "status", "unknown"),
            decisionStatus: stringField(decision, "status", "not_evaluated"),
            decisionReason: stringField(decision, "reason", ""),
          } satisfies ProjectRequestSnapshot;
        })
        .filter((request): request is ProjectRequestSnapshot => Boolean(request))
    : [];

  const host = stringField(record, "host");
  return {
    id,
    name,
    repo: stringField(record, "repo"),
    template: stringField(record, "template"),
    compute: stringField(record, "compute"),
    ...(host ? { host } : {}),
    agents,
    tasks,
    resources,
    resourceRequests,
  };
}

function summarizeState(payload: unknown): AgentCloudStateSummary {
  if (!payload || typeof payload !== "object") {
    throw new LoopbackApiError("Unexpected /api/state response shape.");
  }
  const record = payload as {
    revision?: unknown;
    projects?: unknown;
  };
  if (typeof record.revision !== "number" || !Array.isArray(record.projects)) {
    throw new LoopbackApiError(
      "Unexpected /api/state response — expected revision and projects.",
    );
  }
  const projects = record.projects
    .map(mapProject)
    .filter((project): project is ProjectSnapshot => Boolean(project));

  return {
    revision: record.revision,
    projectCount: projects.length,
    projects,
  };
}

export class LoopbackApiClient {
  private readonly getBaseUrl: () => string;
  private readonly request: HumanRequest;

  constructor(options: {
    getBaseUrl: () => string;
    request: HumanRequest;
  }) {
    this.getBaseUrl = options.getBaseUrl;
    this.request = options.request;
  }

  async getState(): Promise<AgentCloudStateSummary> {
    const baseUrl = this.getBaseUrl();
    let response: Response;
    try {
      response = await this.request("/api/state", { method: "GET" });
    } catch {
      throw new LoopbackApiError(serverUnreachableMessage(baseUrl));
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LoopbackApiError(
        mapApiFailure(response.status, text, baseUrl),
        response.status,
      );
    }

    try {
      return summarizeState(JSON.parse(text));
    } catch (error) {
      if (error instanceof LoopbackApiError) throw error;
      throw new LoopbackApiError("Could not parse /api/state JSON.");
    }
  }

  async postAction(
    body: Record<string, unknown>,
  ): Promise<{ state: AgentCloudStateSummary; raw: unknown }> {
    const baseUrl = this.getBaseUrl();
    let response: Response;
    try {
      response = await this.request("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new LoopbackApiError(serverUnreachableMessage(baseUrl));
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LoopbackApiError(
        mapApiFailure(response.status, text, baseUrl),
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LoopbackApiError("Could not parse POST /api/state JSON.");
    }

    const statePayload =
      parsed &&
      typeof parsed === "object" &&
      "state" in parsed &&
      (parsed as { state: unknown }).state
        ? (parsed as { state: unknown }).state
        : parsed;

    return {
      state: summarizeState(statePayload),
      raw: parsed,
    };
  }
}
