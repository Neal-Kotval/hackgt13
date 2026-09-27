/**
 * In-app SSH terminal transport (HAC-90). Main process only; no Electron imports
 * so it can be exercised directly from node:test.
 *
 * Connection details always come from GET /api/run-boxes/:id/connection with the
 * employee session. The presented host key must equal the pinned
 * `hostPublicKey` byte for byte; anything else aborts the handshake.
 */
import { StringDecoder } from "node:string_decoder";
import ssh2 from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";

export const HOST_KEY_MISMATCH_MESSAGE =
  "Host key does not match the pinned key for this environment";
export const NO_AUTHORIZED_KEY_MESSAGE =
  "This device's key was registered after the environment was created. Create a new environment to include it.";

const HOST_KEY_PATTERN = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})$/;

export type RunBoxConnection = {
  runBoxId: string;
  host: string;
  port: number;
  username: string;
  hostPublicKey: string;
  knownHostsLine: string;
  access: string;
};

export class ConnectionError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "ConnectionError";
    this.status = options.status;
    this.code = options.code;
  }
}

/** Parse `ssh-ed25519 AAAA…` into its key type and wire blob. */
export function parsePinnedHostKey(hostPublicKey: string): {
  type: string;
  blob: Buffer;
} {
  const [type, data] = hostPublicKey.trim().split(/\s+/);
  const match = HOST_KEY_PATTERN.exec(`${type} ${data}`);
  if (!match) {
    throw new ConnectionError(
      "Environment has no valid pinned ssh-ed25519 host key; refusing to connect.",
    );
  }
  const blob = Buffer.from(match[2], "base64");
  if (
    blob.length < 4 ||
    blob.readUInt32BE(0) !== match[1].length ||
    blob.subarray(4, 4 + match[1].length).toString("latin1") !== match[1]
  ) {
    throw new ConnectionError("Pinned host key blob is malformed; refusing to connect.");
  }
  return { type: match[1], blob };
}

/**
 * ssh2 `hostVerifier`: accept only the exact pinned key blob.
 * `onMismatch` lets callers replace ssh2's generic handshake error.
 */
export function createHostVerifier(
  hostPublicKey: string,
  onMismatch?: () => void,
): (key: Buffer) => boolean {
  const pinned = parsePinnedHostKey(hostPublicKey).blob;
  return (key: Buffer) => {
    const ok = Buffer.isBuffer(key) && key.length === pinned.length && key.equals(pinned);
    if (!ok) onMismatch?.();
    return ok;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Validate a 200 /connection body. Throws ConnectionError on bad shapes. */
export function parseConnectionResponse(
  runBoxId: string,
  payload: unknown,
): RunBoxConnection {
  const record = asRecord(payload);
  if (!record) throw new ConnectionError("Unexpected connection response.");
  const host = typeof record.host === "string" ? record.host.trim() : "";
  const port = typeof record.port === "number" ? record.port : Number(record.port);
  const username = typeof record.username === "string" ? record.username.trim() : "";
  const hostPublicKey =
    typeof record.hostPublicKey === "string" ? record.hostPublicKey.trim() : "";
  if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectionError("Connection details are incomplete for this environment.");
  }
  parsePinnedHostKey(hostPublicKey);
  return {
    runBoxId,
    host,
    port,
    username,
    hostPublicKey,
    knownHostsLine:
      typeof record.knownHostsLine === "string" ? record.knownHostsLine : "",
    access: typeof record.access === "string" ? record.access : "trusted-shell",
  };
}

/** Map a non-2xx /connection response to a user-facing error. */
export function connectionFailure(status: number, bodyText: string): ConnectionError {
  let error = "";
  let code: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string") error = parsed.error;
    if (typeof parsed.code === "string") code = parsed.code;
  } catch {
    // non-JSON body
  }
  if (status === 403 && code === "no_authorized_key") {
    return new ConnectionError(NO_AUTHORIZED_KEY_MESSAGE, { status, code });
  }
  if (status === 401) {
    return new ConnectionError("Employee sign-in required. Sign in again, then retry.", {
      status,
    });
  }
  if (status === 403) {
    return new ConnectionError(error || "You do not have access to this environment.", {
      status,
      code,
    });
  }
  if (status === 404) {
    return new ConnectionError(error || "Environment not found.", { status, code });
  }
  if (status === 409) {
    return new ConnectionError(
      error ? `Environment is not ready: ${error}` : "Environment is not ready for SSH yet.",
      { status, code },
    );
  }
  return new ConnectionError(error || `Connection lookup failed (${status}).`, {
    status,
    code,
  });
}

export async function fetchRunBoxConnection(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  runBoxId: string,
): Promise<RunBoxConnection> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runBoxId)) {
    throw new ConnectionError("Invalid environment id.");
  }
  let response: Response;
  try {
    response = await request(`/api/run-boxes/${encodeURIComponent(runBoxId)}/connection`, {
      method: "GET",
    });
  } catch {
    throw new ConnectionError("Cannot reach AgentCloud to look up connection details.");
  }
  const text = await response.text();
  if (!response.ok) throw connectionFailure(response.status, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConnectionError("Could not parse connection response.");
  }
  return parseConnectionResponse(runBoxId, parsed);
}

export type ShellHandlers = {
  onData: (text: string) => void;
  onClose: (info: { error?: string }) => void;
};

export type ShellSession = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
};

export type OpenShellOptions = {
  host: string;
  port: number;
  username: string;
  hostPublicKey: string;
  privateKey: string;
  cols: number;
  rows: number;
  readyTimeoutMs?: number;
};

function clampSize(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
}

export type PinnedConnectOptions = {
  host: string;
  port: number;
  username: string;
  hostPublicKey: string;
  privateKey: string;
  readyTimeoutMs?: number;
};

/**
 * ssh2 connect config that accepts only the pinned host key and authenticates
 * with the device key. Shared by the terminal and the Codex sign-in tunnel.
 */
export function pinnedConnectConfig(
  options: PinnedConnectOptions,
  onHostKeyMismatch?: () => void,
): ConnectConfig {
  const pinned = parsePinnedHostKey(options.hostPublicKey);
  return {
    host: options.host,
    port: options.port,
    username: options.username,
    privateKey: options.privateKey,
    readyTimeout: options.readyTimeoutMs ?? 20_000,
    // Only negotiate the pinned key type so a valid server is not rejected
    // for offering a different host key first.
    algorithms: { serverHostKey: [pinned.type as "ssh-ed25519"] },
    hostVerifier: createHostVerifier(options.hostPublicKey, onHostKeyMismatch),
  };
}

/**
 * Connect, verify the pinned host key, authenticate with the device key, and
 * open an interactive PTY shell. Resolves once the shell channel is open.
 */
export function openShell(
  options: OpenShellOptions,
  handlers: ShellHandlers,
): Promise<ShellSession> {
  parsePinnedHostKey(options.hostPublicKey);
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let hostKeyMismatch = false;
    let settled = false;
    let closed = false;
    let channel: ClientChannel | null = null;
    const decoder = new StringDecoder("utf8");

    const finish = (error?: string) => {
      if (closed) return;
      closed = true;
      const tail = decoder.end();
      if (tail) handlers.onData(tail);
      handlers.onClose(error ? { error } : {});
    };

    const fail = (error: Error) => {
      const message = hostKeyMismatch ? HOST_KEY_MISMATCH_MESSAGE : error.message;
      if (!settled) {
        settled = true;
        closed = true;
        client.end();
        reject(new ConnectionError(message));
        return;
      }
      finish(message);
      client.end();
    };

    client.on("error", fail);
    client.on("close", () => {
      if (!settled) {
        settled = true;
        closed = true;
        reject(
          new ConnectionError(
            hostKeyMismatch ? HOST_KEY_MISMATCH_MESSAGE : "SSH connection closed before the shell opened.",
          ),
        );
        return;
      }
      finish();
    });

    client.on("ready", () => {
      client.shell(
        {
          term: "xterm-256color",
          cols: clampSize(options.cols, 80),
          rows: clampSize(options.rows, 24),
        },
        (error, stream) => {
          if (error) {
            fail(error);
            return;
          }
          channel = stream;
          stream.on("data", (chunk: Buffer) => handlers.onData(decoder.write(chunk)));
          stream.stderr.on("data", (chunk: Buffer) => handlers.onData(decoder.write(chunk)));
          stream.on("close", () => {
            finish();
            client.end();
          });
          settled = true;
          resolve({
            write: (data) => {
              if (!closed) channel?.write(data);
            },
            resize: (cols, rows) => {
              if (!closed) {
                channel?.setWindow(clampSize(rows, 24), clampSize(cols, 80), 0, 0);
              }
            },
            close: () => {
              if (closed) return;
              channel?.close();
              client.end();
            },
          });
        },
      );
    });

    const config = pinnedConnectConfig(options, () => {
      hostKeyMismatch = true;
    });
    try {
      client.connect(config);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
