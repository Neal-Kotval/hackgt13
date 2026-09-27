/**
 * Tracks open SSH terminal sessions per renderer (HAC-90). Main process only.
 * Sessions are keyed by a renderer-chosen id and owned by one webContents; only
 * that owner may write, resize, or close them. All owner sessions are closed
 * when its window goes away.
 */
import type { TerminalEvent } from "../src/lib/types.ts";
import {
  fetchRunBoxConnection,
  openShell,
  type ShellSession,
} from "./ssh-terminal.ts";

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_WRITE = 64 * 1024;

export type TerminalDeps = {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  privateKey: () => string;
  /** Called before connecting so a newly signed-in device key is registered. */
  beforeConnect?: () => Promise<void>;
  open?: typeof openShell;
};

type Entry = { ownerId: number; session: ShellSession | null; closed: boolean };

export class TerminalSessions {
  private readonly sessions = new Map<string, Entry>();
  private readonly deps: TerminalDeps;

  constructor(deps: TerminalDeps) {
    this.deps = deps;
  }

  async open(
    ownerId: number,
    send: (event: TerminalEvent) => void,
    sessionId: string,
    runBoxId: string,
    size: { cols: number; rows: number },
  ): Promise<{ sessionId: string; username: string; host: string; port: number }> {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
      throw new Error("Invalid terminal session id.");
    }
    if (this.sessions.has(sessionId)) throw new Error("Terminal session id already in use.");
    const entry: Entry = { ownerId, session: null, closed: false };
    this.sessions.set(sessionId, entry);
    try {
      await this.deps.beforeConnect?.();
      const connection = await fetchRunBoxConnection(this.deps.request, runBoxId);
      if (entry.closed) throw new Error("Terminal was closed before it connected.");
      const session = await (this.deps.open ?? openShell)(
        {
          host: connection.host,
          port: connection.port,
          username: connection.username,
          hostPublicKey: connection.hostPublicKey,
          privateKey: this.deps.privateKey(),
          cols: Number(size?.cols) || 80,
          rows: Number(size?.rows) || 24,
        },
        {
          onData: (data) => {
            if (data) send({ type: "data", sessionId, data });
          },
          onClose: (info) => {
            entry.closed = true;
            this.sessions.delete(sessionId);
            send({ type: "closed", sessionId, ...(info.error ? { error: info.error } : {}) });
          },
        },
      );
      if (entry.closed) {
        session.close();
        throw new Error("Terminal was closed before it connected.");
      }
      entry.session = session;
      return {
        sessionId,
        username: connection.username,
        host: connection.host,
        port: connection.port,
      };
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  private owned(ownerId: number, sessionId: string): Entry | null {
    const entry = this.sessions.get(sessionId);
    return entry && entry.ownerId === ownerId ? entry : null;
  }

  write(ownerId: number, sessionId: string, data: unknown): void {
    if (typeof data !== "string" || data.length > MAX_WRITE) return;
    this.owned(ownerId, sessionId)?.session?.write(data);
  }

  resize(ownerId: number, sessionId: string, cols: unknown, rows: unknown): void {
    if (typeof cols !== "number" || typeof rows !== "number") return;
    this.owned(ownerId, sessionId)?.session?.resize(cols, rows);
  }

  close(ownerId: number, sessionId: string): void {
    const entry = this.owned(ownerId, sessionId);
    if (!entry) return;
    entry.closed = true;
    entry.session?.close();
    this.sessions.delete(sessionId);
  }

  closeOwner(ownerId: number): void {
    for (const [sessionId, entry] of this.sessions) {
      if (entry.ownerId === ownerId) this.close(ownerId, sessionId);
    }
  }

  closeAll(): void {
    for (const [sessionId, entry] of this.sessions) this.close(entry.ownerId, sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }
}
