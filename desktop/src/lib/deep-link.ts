export type DeepLinkTarget = {
  projectId: string;
  environmentId?: string;
  codexSessionId?: string;
  /** Run-box job id. Opens the Project chat SSH terminal; never carries host/port. */
  runBoxId?: string;
  /** Legacy task run-box link; opens its SSH terminal now that Tasks is removed. */
  taskRunBoxId?: string;
  /** Source server identity only. Never used as a request destination. */
  serverUrl?: string;
};

export type DeepLinkParseResult =
  | { ok: true; target: DeepLinkTarget }
  | { ok: false; error: string };

const SCHEME = "agentcloud:";

/**
 * Parse `agentcloud://open?projectId=…&environmentId=…` (environment optional)
 * or `agentcloud://open?projectId=…&runBoxId=…`, or a codexSessionId. Other query values —
 * including host or port — are ignored; connection details always come from
 * the authenticated connection API.
 */
export function parseAgentCloudDeepLink(raw: string): DeepLinkParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Deep link URL is empty." };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Deep link URL is malformed." };
  }
  if (url.protocol !== SCHEME) {
    return {
      ok: false,
      error: `Expected agentcloud:// link, got ${url.protocol}//`,
    };
  }
  const hostOrPath = (url.hostname || url.pathname.replace(/^\//, "")).toLowerCase();
  if (hostOrPath !== "open") {
    return {
      ok: false,
      error: "Unsupported agentcloud link. Use agentcloud://open?projectId=…",
    };
  }
  const projectId = url.searchParams.get("projectId")?.trim() || "";
  if (!projectId) {
    return {
      ok: false,
      error: "Deep link is missing projectId.",
    };
  }
  const environmentId = url.searchParams.get("environmentId")?.trim() || undefined;
  const runBoxId = url.searchParams.get("runBoxId")?.trim() || undefined;
  if (runBoxId && !/^[A-Za-z0-9_-]{1,128}$/.test(runBoxId)) {
    return { ok: false, error: "Deep link runBoxId is malformed." };
  }
  const taskRunBoxId = url.searchParams.get("taskRunBoxId")?.trim() || undefined;
  if (taskRunBoxId && !/^[A-Za-z0-9_-]{1,128}$/.test(taskRunBoxId)) {
    return { ok: false, error: "Deep link taskRunBoxId is malformed." };
  }
  const serverUrlRaw = url.searchParams.get("serverUrl")?.trim() || undefined;
  let serverUrl: string | undefined;
  if (serverUrlRaw) {
    try {
      const source = new URL(serverUrlRaw);
      const loopback = source.hostname === "localhost" || source.hostname === "127.0.0.1" || source.hostname === "[::1]";
      if ((source.protocol !== "https:" && !(source.protocol === "http:" && loopback)) || source.username || source.password || source.pathname !== "/" || source.search || source.hash) throw new Error("invalid source");
      serverUrl = source.origin;
    } catch {
      return { ok: false, error: "Deep link serverUrl must be an HTTPS origin or an HTTP loopback origin." };
    }
  }
  const codexSessionId = url.searchParams.get("codexSessionId")?.trim() || undefined;
  if (codexSessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(codexSessionId)) return { ok: false, error: "Deep link codexSessionId is malformed." };
  if ([codexSessionId, runBoxId, taskRunBoxId, environmentId].filter(Boolean).length > 1) return { ok: false, error: "Deep link contains conflicting destinations." };
  return {
    ok: true,
    target: {
      projectId,
      ...(codexSessionId ? { codexSessionId } : {}),
      ...(environmentId ? { environmentId } : {}),
      ...(runBoxId ? { runBoxId } : {}),
      ...(taskRunBoxId ? { taskRunBoxId } : {}),
      ...(serverUrl ? { serverUrl } : {}),
    },
  };
}

export function deepLinkServerError(target: DeepLinkTarget, configuredBaseUrl: string): string | null {
  if (!target.serverUrl) return null;
  try {
    if (new URL(configuredBaseUrl).origin === target.serverUrl) return null;
  } catch {
    // Display the configured value so the employee can correct it.
  }
  return `This link came from a different alto server (${target.serverUrl}). Desktop is connected to ${configuredBaseUrl}. Sign out, set AGENTCLOUD_URL to the link's server, then sign in and open the link again.`;
}

export function findDeepLinkUrl(argv: string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("agentcloud://")) {
      return arg;
    }
  }
  return null;
}
