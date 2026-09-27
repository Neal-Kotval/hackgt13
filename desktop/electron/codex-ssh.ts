/**
 * Non-interactive ssh2 exec channels for the Codex panel (HAC-122). Main
 * process only. Trust decisions are reused from ssh-terminal.ts: the pinned
 * host key parser/verifier and the authenticated connection lookup. Nothing
 * here logs command output, keys, or stdin contents.
 */
import ssh2 from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";
import {
  ConnectionError,
  HOST_KEY_MISMATCH_MESSAGE,
  createHostVerifier,
  parsePinnedHostKey,
} from "./ssh-terminal.ts";

export type ExecTarget = {
  host: string;
  port: number;
  username: string;
  hostPublicKey: string;
  privateKey: string;
  readyTimeoutMs?: number;
};

export type ExecHandlers = {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
};

export type ExecHandle = {
  /** Resolves with the remote exit code (null when killed by a signal or closed). */
  done: Promise<{ exitCode: number | null; signal: string | null }>;
  /** Close the channel and the connection. Does not by itself kill the remote process. */
  close: () => void;
  /** Best-effort SSH "signal" request (OpenSSH ≥ 7.9 honours it for the session child). */
  signal: (name: "TERM" | "INT" | "KILL") => void;
};

/**
 * Connect with the pinned host key and device key, run one command, and stream
 * its output. `stdin`, when given, is written and then EOF is sent; otherwise
 * EOF is sent immediately.
 */
export function execRemote(
  target: ExecTarget,
  command: string,
  handlers: ExecHandlers = {},
  stdin?: Buffer | string,
): Promise<ExecHandle> {
  const pinned = parsePinnedHostKey(target.hostPublicKey);
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let hostKeyMismatch = false;
    let settled = false;
    let channel: ClientChannel | null = null;
    let finish: (value: { exitCode: number | null; signal: string | null }) => void = () => {};
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((res) => {
      finish = res;
    });
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      finish({ exitCode, signal: exitSignal });
    };

    const fail = (error: Error) => {
      const message = hostKeyMismatch ? HOST_KEY_MISMATCH_MESSAGE : error.message;
      if (!settled) {
        settled = true;
        client.end();
        reject(new ConnectionError(message));
        return;
      }
      complete();
      client.end();
    };

    client.on("error", fail);
    client.on("close", () => {
      if (!settled) {
        settled = true;
        reject(
          new ConnectionError(
            hostKeyMismatch
              ? HOST_KEY_MISMATCH_MESSAGE
              : "SSH connection closed before the command started.",
          ),
        );
        return;
      }
      complete();
    });

    client.on("ready", () => {
      client.exec(command, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        channel = stream;
        stream.on("data", (chunk: Buffer) => handlers.onStdout?.(chunk));
        stream.stderr.on("data", (chunk: Buffer) => handlers.onStderr?.(chunk));
        stream.on("exit", (code: number | null, signal?: string) => {
          exitCode = typeof code === "number" ? code : null;
          exitSignal = typeof signal === "string" ? signal : null;
        });
        stream.on("close", () => {
          complete();
          client.end();
        });
        if (stdin !== undefined) stream.end(stdin);
        else stream.end();
        settled = true;
        resolve({
          done,
          close: () => {
            channel?.close();
            client.end();
          },
          signal: (name) => {
            try {
              channel?.signal(name);
            } catch {
              // server may not support signal requests
            }
          },
        });
      });
    });

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      readyTimeout: target.readyTimeoutMs ?? 20_000,
      algorithms: { serverHostKey: [pinned.type as "ssh-ed25519"] },
      hostVerifier: createHostVerifier(target.hostPublicKey, () => {
        hostKeyMismatch = true;
      }),
    };
    try {
      client.connect(config);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Run a command to completion and collect bounded output. */
export async function execCollect(
  target: ExecTarget,
  command: string,
  options: { stdin?: Buffer | string; maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean }> {
  const max = options.maxBytes ?? 1024 * 1024;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let truncated = false;
  const handle = await execRemote(
    target,
    command,
    {
      onStdout: (chunk) => {
        if (outBytes + chunk.length > max) {
          truncated = true;
          return;
        }
        outBytes += chunk.length;
        out.push(chunk);
      },
      onStderr: (chunk) => {
        if (errBytes + chunk.length > 64 * 1024) return;
        errBytes += chunk.length;
        err.push(chunk);
      },
    },
    options.stdin,
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    if (!options.timeoutMs) return;
    timer = setTimeout(() => {
      handle.close();
      resolve({ exitCode: null, signal: "TIMEOUT" });
    }, options.timeoutMs);
  });
  const result = await Promise.race([handle.done, timeout]);
  if (timer) clearTimeout(timer);
  return {
    exitCode: result.exitCode,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
    truncated,
  };
}
