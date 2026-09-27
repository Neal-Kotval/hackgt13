/**
 * ChatGPT browser sign-in tunnel for Codex on an environment (HAC-161). Main
 * process only; no Electron imports so node:test can exercise it directly.
 *
 * Codex's OAuth callback server listens on 127.0.0.1:<port> on the environment
 * and the browser is redirected to http://localhost:<port>/auth/callback on this
 * Mac. The tunnel listens on 127.0.0.1:<port> here (loopback only) and forwards
 * each connection over SSH (`direct-tcpip`) to 127.0.0.1:<port> on the
 * environment. SSH uses the same trust path as the terminal: connection details
 * from GET /api/run-boxes/:id/connection, the pinned host key, and this device's
 * key.
 *
 * The browser is opened only after the tunnel is listening and SSH is up, and
 * only for an https://auth.openai.com/ URL whose redirect port is the tunnel's.
 * The tunnel closes on sign-in completion, cancel, window close, or timeout.
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import ssh2 from "ssh2";
import { browserLoginCallbackPort, CODEX_CALLBACK_PORTS } from "../src/lib/chatgpt-sign-in.ts";
import {
  fetchRunBoxConnection,
  HOST_KEY_MISMATCH_MESSAGE,
  NO_AUTHORIZED_KEY_MESSAGE,
  pinnedConnectConfig,
  type PinnedConnectOptions,
} from "./ssh-terminal.ts";

export const LOGIN_TUNNEL_TIMEOUT_MS = 10 * 60_000;
export const UNREACHABLE_MESSAGE = "Could not reach the environment over SSH. Check that it is running, then try again.";
export const FORWARD_REFUSED_MESSAGE =
  "The environment refused to forward the sign-in callback. Use a device code instead.";
export const TIMEOUT_MESSAGE = "ChatGPT sign-in timed out after 10 minutes. Start it again when you're ready.";
export const TUNNEL_CLOSED_MESSAGE = "The SSH connection for ChatGPT sign-in closed. Start sign-in again.";
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export class LoginTunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginTunnelError";
  }
}

export function portInUseMessage(port: number): string {
  return `Port ${port} on this Mac is in use (is another Codex sign-in running?). Close it, or use a device code instead.`;
}

/** Map a local listen error to a fixed message. */
export function listenFailure(error: NodeJS.ErrnoException, port: number): LoginTunnelError {
  if (error.code === "EADDRINUSE") return new LoginTunnelError(portInUseMessage(port));
  if (error.code === "EACCES") return new LoginTunnelError(`This Mac did not allow AgentCloud to use port ${port} for sign-in.`);
  return new LoginTunnelError(`Could not open port ${port} on this Mac for sign-in.`);
}

/** Map an ssh2 connect error to a fixed message. Raw ssh2 text is never shown. */
export function sshFailure(error: unknown, hostKeyMismatch: boolean): LoginTunnelError {
  if (hostKeyMismatch) return new LoginTunnelError(HOST_KEY_MISMATCH_MESSAGE);
  const record = (error ?? {}) as { level?: unknown; code?: unknown };
  if (record.level === "client-authentication") return new LoginTunnelError(NO_AUTHORIZED_KEY_MESSAGE);
  return new LoginTunnelError(UNREACHABLE_MESSAGE);
}

export type SshForwarder = {
  /** Open a direct-tcpip channel to 127.0.0.1:<remotePort> on the environment. */
  forward: (sourcePort: number, remotePort: number) => Promise<Duplex>;
  close: () => void;
  /** Called once when the SSH connection ends; `error` is a fixed message. */
  onClose: (listener: (error?: string) => void) => void;
};

/** Connect with the pinned host key and device key; resolves when SSH is ready. */
export function connectForwarder(options: PinnedConnectOptions): Promise<SshForwarder> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let hostKeyMismatch = false;
    let ready = false;
    let ended = false;
    const listeners: Array<(error?: string) => void> = [];
    const end = (error?: string) => {
      if (ended) return;
      ended = true;
      for (const listener of listeners.splice(0)) {
        try {
          listener(error);
        } catch {
          // isolate listeners
        }
      }
    };
    client.on("error", (error) => {
      if (!ready) {
        ended = true;
        client.end();
        reject(sshFailure(error, hostKeyMismatch));
        return;
      }
      end(TUNNEL_CLOSED_MESSAGE);
      client.end();
    });
    client.on("close", () => {
      if (!ready) {
        if (!ended) {
          ended = true;
          reject(sshFailure(null, hostKeyMismatch));
        }
        return;
      }
      end(TUNNEL_CLOSED_MESSAGE);
    });
    client.on("ready", () => {
      ready = true;
      resolve({
        forward: (sourcePort, remotePort) =>
          new Promise((resolveChannel, rejectChannel) => {
            client.forwardOut("127.0.0.1", sourcePort, "127.0.0.1", remotePort, (error, channel) => {
              if (error) {
                const reason = /prohibited/i.test(error.message)
                  ? FORWARD_REFUSED_MESSAGE
                  : "Codex's sign-in listener on the environment is not running. Start sign-in again.";
                rejectChannel(new LoginTunnelError(reason));
                return;
              }
              resolveChannel(channel);
            });
          }),
        close: () => {
          end();
          client.end();
        },
        onClose: (listener) => {
          if (ended) listener();
          else listeners.push(listener);
        },
      });
    });
    try {
      client.connect({
        ...pinnedConnectConfig(options, () => {
          hostKeyMismatch = true;
        }),
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
      });
    } catch (error) {
      ended = true;
      reject(sshFailure(error, hostKeyMismatch));
    }
  });
}

export type LoginTunnel = { port: number; close: () => void };

function listenLoopback(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ pauseOnConnect: true });
    const onError = (error: NodeJS.ErrnoException) => {
      server.close();
      reject(listenFailure(error, port));
    };
    server.once("error", onError);
    // Loopback only: the callback carries an OAuth code. `exclusive` keeps the port to this process.
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

/**
 * Listen on 127.0.0.1:<listenPort> (fail fast if busy), then connect SSH, then
 * forward every accepted socket to 127.0.0.1:<remotePort> on the environment.
 */
export async function openLoginTunnel(options: {
  connection: PinnedConnectOptions;
  listenPort: number;
  remotePort: number;
  connect?: (options: PinnedConnectOptions) => Promise<SshForwarder>;
  onClose: (error?: string) => void;
}): Promise<LoginTunnel> {
  const server = await listenLoopback(options.listenPort);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.listenPort;
  let forwarder: SshForwarder;
  try {
    forwarder = await (options.connect ?? connectForwarder)(options.connection);
  } catch (error) {
    server.close();
    throw error instanceof LoginTunnelError ? error : new LoginTunnelError(UNREACHABLE_MESSAGE);
  }
  const sockets = new Set<net.Socket>();
  let closed = false;
  const close = (error?: string) => {
    if (closed) return;
    closed = true;
    server.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    forwarder.close();
    options.onClose(error);
  };
  forwarder.onClose((error) => close(error ?? TUNNEL_CLOSED_MESSAGE));
  server.on("connection", (socket: net.Socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    forwarder.forward(socket.remotePort ?? 0, options.remotePort).then(
      (channel) => {
        if (closed || socket.destroyed) {
          channel.destroy();
          return;
        }
        channel.on("error", () => socket.destroy());
        channel.on("close", () => socket.destroy());
        socket.on("close", () => channel.destroy());
        socket.pipe(channel);
        channel.pipe(socket);
        socket.resume();
      },
      () => socket.destroy(),
    );
  });
  server.on("error", () => close(TUNNEL_CLOSED_MESSAGE));
  return { port, close: () => close() };
}

export type LoginTunnelEvent = { type: "closed"; sessionId: string; error?: string };

export type LoginTunnelDeps = {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  privateKey: () => string;
  /** Called before connecting so a newly signed-in device key is registered. */
  beforeConnect?: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  connect?: (options: PinnedConnectOptions) => Promise<SshForwarder>;
  timeoutMs?: number;
};

type Entry = {
  ownerId: number;
  sessionId: string;
  port: number;
  tunnel: LoginTunnel | null;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
};

/**
 * One browser sign-in tunnel at a time per callback port. Keyed by Codex
 * session id and owned by one renderer; only that owner may stop it.
 */
export class CodexLoginTunnels {
  private readonly entries = new Map<string, Entry>();
  private readonly deps: LoginTunnelDeps;

  constructor(deps: LoginTunnelDeps) {
    this.deps = deps;
  }

  async start(
    ownerId: number,
    send: (event: LoginTunnelEvent) => void,
    input: { sessionId: unknown; runBoxId: unknown; authUrl: unknown; callbackPort: unknown },
  ): Promise<{ callbackPort: number }> {
    const { sessionId, runBoxId, authUrl, callbackPort } = input;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new LoginTunnelError("Invalid Codex session.");
    if (typeof runBoxId !== "string") throw new LoginTunnelError("Invalid environment id.");
    if (typeof callbackPort !== "number" || !CODEX_CALLBACK_PORTS.includes(callbackPort)) {
      throw new LoginTunnelError("Codex asked for a sign-in port AgentCloud does not forward.");
    }
    // Re-validated here, never trusted from the renderer.
    if (typeof authUrl !== "string" || browserLoginCallbackPort(authUrl) !== callbackPort) {
      throw new LoginTunnelError("Refusing to open a sign-in address outside https://auth.openai.com/.");
    }
    // A new attempt replaces this session's tunnel and any AgentCloud tunnel on the same port.
    for (const entry of [...this.entries.values()]) {
      if (entry.sessionId === sessionId || entry.port === callbackPort) this.closeEntry(entry);
    }
    const entry: Entry = { ownerId, sessionId, port: callbackPort, tunnel: null, timer: null, cancelled: false };
    this.entries.set(sessionId, entry);
    try {
      await this.deps.beforeConnect?.();
      const connection = await fetchRunBoxConnection(this.deps.request, runBoxId);
      if (entry.cancelled) throw new LoginTunnelError("Sign-in was cancelled.");
      const tunnel = await openLoginTunnel({
        connection: {
          host: connection.host,
          port: connection.port,
          username: connection.username,
          hostPublicKey: connection.hostPublicKey,
          privateKey: this.deps.privateKey(),
        },
        listenPort: callbackPort,
        remotePort: callbackPort,
        connect: this.deps.connect,
        onClose: (error) => {
          if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
          if (entry.timer) clearTimeout(entry.timer);
          if (!entry.cancelled) send({ type: "closed", sessionId, ...(error ? { error } : {}) });
        },
      });
      if (entry.cancelled) {
        tunnel.close();
        throw new LoginTunnelError("Sign-in was cancelled.");
      }
      entry.tunnel = tunnel;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const active = entry.tunnel;
        entry.tunnel = null;
        if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
        send({ type: "closed", sessionId, error: TIMEOUT_MESSAGE });
        entry.cancelled = true;
        active?.close();
      }, this.deps.timeoutMs ?? LOGIN_TUNNEL_TIMEOUT_MS);
      entry.timer.unref?.();
      await this.deps.openExternal(authUrl);
      return { callbackPort };
    } catch (error) {
      if (this.entries.get(sessionId) === entry) this.closeEntry(entry);
      throw error;
    }
  }

  private closeEntry(entry: Entry): void {
    entry.cancelled = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (this.entries.get(entry.sessionId) === entry) this.entries.delete(entry.sessionId);
    const tunnel = entry.tunnel;
    entry.tunnel = null;
    tunnel?.close();
  }

  /** Close the tunnel for a session (sign-in finished, cancelled, or abandoned). */
  stop(ownerId: number, sessionId: unknown): void {
    if (typeof sessionId !== "string") return;
    const entry = this.entries.get(sessionId);
    if (entry && entry.ownerId === ownerId) this.closeEntry(entry);
  }

  closeOwner(ownerId: number): void {
    for (const entry of [...this.entries.values()]) if (entry.ownerId === ownerId) this.closeEntry(entry);
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) this.closeEntry(entry);
  }

  get size(): number {
    return this.entries.size;
  }
}
