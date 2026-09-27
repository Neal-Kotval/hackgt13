export type DeepLinkTarget = {
  projectId: string;
  environmentId?: string;
  codexSessionId?: string;
  /** Run-box job id (HAC-90). Opens Environments; never carries host/port. */
  runBoxId?: string;
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
  const codexSessionId = url.searchParams.get("codexSessionId")?.trim() || undefined;
  if (codexSessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(codexSessionId)) return { ok: false, error: "Deep link codexSessionId is malformed." };
  if (codexSessionId && (runBoxId || environmentId)) return { ok: false, error: "Deep link contains conflicting destinations." };
  return {
    ok: true,
    target: {
      projectId,
      ...(codexSessionId ? { codexSessionId } : {}),
      ...(environmentId ? { environmentId } : {}),
      ...(runBoxId ? { runBoxId } : {}),
    },
  };
}

export function findDeepLinkUrl(argv: string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("agentcloud://")) {
      return arg;
    }
  }
  return null;
}
