/**
 * HAC-166: admits this Mac's network to an aws-cpu environment before SSH.
 *
 * An aws-cpu box accepts tcp/22 only from job-tagged /32 rules. The server learns
 * this device's public IPv4 from CloudFront's viewer address, so the registration
 * request must itself travel over IPv4: a browser or dual-stack fetch may reach
 * CloudFront over IPv6 and leave no IPv4 to admit. `ipv4Fetch` resolves and
 * connects over IPv4 only (lookup family 4, no Happy Eyeballs fallback), the same
 * address family ssh2 uses to reach the box's public IPv4.
 */
import http from "node:http";
import https from "node:https";
import { ENVIRONMENT_ACCESS_PENDING } from "../src/lib/environment-access.ts";

export const AWS_CPU_PROFILE_ID = "aws-cpu";
export const ACCESS_WAIT_MS = 60_000;
export const ACCESS_POLL_MS = 2_000;

export const ACCESS_MESSAGES = {
  pending: ENVIRONMENT_ACCESS_PENDING,
  noIpv4:
    "AgentCloud could not see a public IPv4 address for this Mac. Connect to a network with IPv4 internet access, then retry.",
  timeout:
    "The environment did not admit this Mac's network within a minute. Retry; if it keeps failing, ask the project owner to check the AgentCloud worker.",
  failed: "AgentCloud could not add a network rule for this Mac. Retry.",
  notReady: "The environment is not ready for connections yet.",
  unreachable: "Cannot reach AgentCloud over IPv4 to allow this Mac's network.",
} as const;

export class EnvironmentAccessError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "EnvironmentAccessError";
    this.code = code;
  }
}

type RequestFn = typeof http.request;

/** Connection options that pin a request to IPv4. Exported for tests. */
export function ipv4ConnectOptions(): { family: 4; autoSelectFamily: false } {
  return { family: 4, autoSelectFamily: false };
}

/**
 * A fetch-compatible function for small JSON requests that connects over IPv4
 * only. Redirects are not followed. `transport` is injectable for tests.
 */
export function createIpv4Fetch(
  transport: { http: RequestFn; https: RequestFn } = { http: http.request, https: https.request },
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const request = url.protocol === "https:" ? transport.https : url.protocol === "http:" ? transport.http : null;
    if (!request) throw new TypeError("Only http and https are supported.");
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        { method: init.method || "GET", headers, ...ipv4ConnectOptions(), timeout: 15_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
              else if (typeof value === "string") responseHeaders.set(key, value);
            }
            const status = res.statusCode || 500;
            const text = Buffer.concat(chunks);
            resolve(new Response(status === 204 || status === 304 ? null : text, { status, headers: responseHeaders }));
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("IPv4 request timed out")));
      req.on("error", reject);
      init.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }) as typeof fetch;
}

export type AccessRequest = (path: string, init?: RequestInit) => Promise<Response>;

type Outcome = "applied" | "not-managed";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await response.text());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function refusal(status: number, payload: Record<string, unknown>): EnvironmentAccessError | "not-managed" {
  const code = typeof payload.code === "string" ? payload.code : "";
  if (status === 409 && code === "no_ipv4") return new EnvironmentAccessError(ACCESS_MESSAGES.noIpv4, code);
  // The server does not read requester addresses (local development) or this is not an
  // aws-cpu box: the environment's own SSH rules decide, so connect as before.
  if (status === 409 && (code === "address_untrusted" || code === "not_aws_cpu")) return "not-managed";
  if (status === 409 && code === "not_ready") return new EnvironmentAccessError(ACCESS_MESSAGES.notReady, code);
  if (status === 401) return new EnvironmentAccessError("Employee sign-in required. Sign in again, then retry.", "unauthorized");
  const error = typeof payload.error === "string" ? payload.error : `Request failed (${status}).`;
  return new EnvironmentAccessError(error, code || `http_${status}`);
}

/**
 * Registers this device's IPv4 for `runBoxId` and waits until the worker has
 * applied it. `request` must use the IPv4-only transport. `onPending` runs once
 * when the server reports the address as pending.
 */
export async function ensureEnvironmentAccess(
  request: AccessRequest,
  runBoxId: string,
  onPending: () => void,
  options: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<Outcome> {
  const path = `/api/run-boxes/${encodeURIComponent(runBoxId)}/ssh-access`;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const call = async (method: "POST" | "GET") => {
    try {
      const response = await request(path, method === "POST"
        ? { method, headers: { "content-type": "application/json" }, body: "{}" }
        : { method });
      return { status: response.status, payload: await readJson(response) };
    } catch {
      throw new EnvironmentAccessError(ACCESS_MESSAGES.unreachable, "unreachable");
    }
  };

  const first = await call("POST");
  if (first.status === 200 && first.payload.status === "applied") return "applied";
  if (first.status !== 202) {
    const result = refusal(first.status, first.payload);
    if (result === "not-managed") return result;
    throw result;
  }
  onPending();
  const deadline = now() + (options.waitMs ?? ACCESS_WAIT_MS);
  while (now() < deadline) {
    await sleep(options.pollMs ?? ACCESS_POLL_MS);
    const next = await call("GET");
    if (next.status !== 200) {
      const result = refusal(next.status, next.payload);
      if (result === "not-managed") return result;
      throw result;
    }
    const access = next.payload.sshAccess as { status?: unknown } | undefined;
    if (access?.status === "applied") return "applied";
    if (access?.status === "failed") throw new EnvironmentAccessError(ACCESS_MESSAGES.failed, "failed");
    // "none" means this network's address changed or was replaced; register again.
    if (access?.status === "none") {
      const again = await call("POST");
      if (again.status === 200 && again.payload.status === "applied") return "applied";
      if (again.status !== 202) {
        const result = refusal(again.status, again.payload);
        if (result === "not-managed") return result;
        throw result;
      }
    }
  }
  throw new EnvironmentAccessError(ACCESS_MESSAGES.timeout, "timeout");
}
