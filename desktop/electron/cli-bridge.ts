/** Same-user terminal bridge. Credentials and pinned SSH verification stay in main. */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { ConnectionError } from "./ssh-terminal.ts";
import type { TerminalSessions } from "./terminal-sessions.ts";

const MAX_FRAME = 256 * 1024;
const MAX_BUFFER = 1024 * 1024;
export const cliSocketPath = () => path.join(homedir(), ".alto", "desktop.sock");

type Deps = {
  terminals: TerminalSessions;
  signedIn: () => boolean;
  socketPath?: string;
};

export class CliBridge {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private ownerId = -1; // Electron webContents IDs are positive.
  private readonly deps: Deps;
  private readonly socketPath: string;
  constructor(deps: Deps) {
    this.deps = deps;
    this.socketPath = deps.socketPath ?? cliSocketPath();
  }

  async start(): Promise<void> {
    const directory = path.dirname(this.socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.()) {
      throw new Error("The alto CLI directory must be owned by this user and cannot be a symlink.");
    }
    await chmod(directory, 0o700);
    try {
      const existing = await lstat(this.socketPath);
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) {
        throw new Error("Refusing to replace an unsafe alto CLI socket.");
      }
      // Never steal a live listener from another desktop process.
      const active = await new Promise<boolean>((resolve, reject) => {
        const probe = createConnection(this.socketPath);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
          else reject(error);
        });
        probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("alto CLI socket is busy.")); });
      });
      if (active) throw new Error("Another alto desktop already owns the CLI socket.");
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
    await chmod(this.socketPath, 0o600);
    server.on("error", () => this.disconnectAll());
  }

  disconnectAll(): void {
    for (const socket of this.clients) socket.destroy();
  }

  async stop(): Promise<void> {
    this.disconnectAll();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    if (this.clients.size >= 16) { socket.destroy(); return; }
    this.clients.add(socket);
    const owner = this.ownerId--;
    const sessionId = randomUUID();
    let state: "new" | "opening" | "ready" = "new";
    let buffer = "";
    const send = (frame: object) => {
      if (socket.destroyed) return;
      if (socket.writableLength > MAX_BUFFER) { socket.destroy(); return; }
      socket.write(JSON.stringify(frame) + "\n");
    };
    const fail = (message: string) => {
      send({ type: "error", message });
      socket.end();
      this.deps.terminals.closeOwner(owner);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {});
    socket.once("close", () => {
      this.clients.delete(socket);
      this.deps.terminals.closeOwner(owner);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME) { fail("CLI frame exceeds the size limit."); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (!frame || typeof frame !== "object") throw new Error();
          if (state === "new" && frame.type === "open") {
            if (!this.deps.signedIn()) { fail("Sign in to the alto desktop app first."); return; }
            if (typeof frame.runBoxId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.runBoxId)) throw new Error();
            state = "opening";
            socket.setTimeout(0);
            send({ type: "status", message: "Connecting through alto desktop…" });
            const deadline = Date.now() + 60000;
            const open = async (): Promise<unknown> => {
              try {
                return await this.deps.terminals.open(owner, (event) => {
                  if (event.type === "data") {
                    // Keep each frame bounded without splitting a Unicode character.
                    for (let i = 0; i < event.data.length;) {
                      let end = Math.min(i + 16384, event.data.length);
                      const last = event.data.charCodeAt(end - 1);
                      if (end < event.data.length && last >= 0xd800 && last <= 0xdbff) end--;
                      send({ type: "data", data: event.data.slice(i, end) });
                      i = end;
                    }
                  } else if (event.type === "closed") {
                    send({ type: "closed", ...(event.error ? { error: event.error } : {}) });
                    socket.end();
                  } else send({ type: "status", message: "Authorizing this device's network for SSH…" });
                }, sessionId, frame.runBoxId, { cols: frame.cols, rows: frame.rows });
              } catch (error) {
                const pendingKey = error instanceof ConnectionError &&
                  (error.code === "no_authorized_key" || error.message === "All configured authentication methods failed");
                if (!pendingKey || Date.now() >= deadline || socket.destroyed || socket.writableEnded) throw error;
                send({ type: "status", message: "Waiting for this device's SSH key to be installed…" });
                await new Promise<void>((resolve) => setTimeout(resolve, 2000));
                if (socket.destroyed || socket.writableEnded) return;
                return open();
              }
            };
            void open().then(() => {
              if (socket.destroyed || socket.writableEnded) { this.deps.terminals.closeOwner(owner); return; }
              state = "ready";
              send({ type: "ready" });
            }).catch((error: unknown) => fail(error instanceof Error ? error.message : "SSH connection failed."));
          } else if (frame.type === "close") {
            socket.end();
            this.deps.terminals.closeOwner(owner);
          } else if (state === "ready" && frame.type === "input" && typeof frame.data === "string" && frame.data.length <= 65536) {
            this.deps.terminals.write(owner, sessionId, frame.data);
          } else if (state === "ready" && frame.type === "resize" && Number.isInteger(frame.cols) && Number.isInteger(frame.rows)) {
            this.deps.terminals.resize(owner, sessionId, frame.cols, frame.rows);
          } else throw new Error();
        } catch { fail("Invalid alto CLI request."); return; }
      }
    });
  }
}
