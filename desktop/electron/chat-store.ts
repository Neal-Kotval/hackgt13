import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChatMessage,
  ChatStoreSnapshot,
  ChatThread,
  ChatThreadSummary,
  MessageRole,
  MessageStatus,
} from "../src/lib/types.ts";

const STORE_VERSION = 1 as const;
const PLACEHOLDER_TITLE = "New chat";

export class ChatStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatStoreError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptySnapshot(): ChatStoreSnapshot {
  return { version: STORE_VERSION, threads: [] };
}

function summarize(thread: ChatThread): ChatThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: thread.messages.length,
  };
}

function titleFromFirstUserMessage(content: string): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  if (!trimmed) return PLACEHOLDER_TITLE;
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
}

export class ChatStore {
  readonly rootDir: string;
  private readonly indexPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.indexPath = path.join(rootDir, "threads.json");
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    try {
      await this.readSnapshot();
    } catch (error) {
      if (
        error instanceof ChatStoreError &&
        error.message.includes("missing")
      ) {
        await this.writeSnapshot(emptySnapshot());
        return;
      }
      throw error;
    }
  }

  listThreads(): Promise<ChatThreadSummary[]> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      return [...snapshot.threads]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summarize);
    });
  }

  createThread(): Promise<ChatThread> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      const stamp = nowIso();
      const thread: ChatThread = {
        id: randomUUID(),
        title: PLACEHOLDER_TITLE,
        createdAt: stamp,
        updatedAt: stamp,
        messages: [],
      };
      snapshot.threads.unshift(thread);
      await this.writeSnapshot(snapshot);
      return structuredClone(thread);
    });
  }

  getThread(threadId: string): Promise<ChatThread | null> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      const thread = snapshot.threads.find((item) => item.id === threadId);
      return thread ? structuredClone(thread) : null;
    });
  }

  deleteThread(threadId: string): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      const next = snapshot.threads.filter((item) => item.id !== threadId);
      if (next.length === snapshot.threads.length) {
        throw new ChatStoreError(`Thread not found: ${threadId}`);
      }
      snapshot.threads = next;
      await this.writeSnapshot(snapshot);
    });
  }

  renameThread(threadId: string, title: string): Promise<ChatThread> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      const thread = snapshot.threads.find((item) => item.id === threadId);
      if (!thread) throw new ChatStoreError(`Thread not found: ${threadId}`);
      const nextTitle = title.trim() || PLACEHOLDER_TITLE;
      thread.title = nextTitle.slice(0, 80);
      thread.updatedAt = nowIso();
      await this.writeSnapshot(snapshot);
      return structuredClone(thread);
    });
  }

  appendMessage(
    threadId: string,
    input: {
      role: MessageRole;
      content: string;
      status?: MessageStatus;
      id?: string;
    },
  ): Promise<ChatMessage> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      const thread = snapshot.threads.find((item) => item.id === threadId);
      if (!thread) throw new ChatStoreError(`Thread not found: ${threadId}`);
      const stamp = nowIso();
      const message: ChatMessage = {
        id: input.id ?? randomUUID(),
        role: input.role,
        content: input.content,
        createdAt: stamp,
        updatedAt: stamp,
        status: input.status ?? "complete",
      };
      thread.messages.push(message);
      if (
        thread.title === PLACEHOLDER_TITLE &&
        input.role === "user" &&
        input.content.trim()
      ) {
        thread.title = titleFromFirstUserMessage(input.content);
      }
      thread.updatedAt = stamp;
      await this.writeSnapshot(snapshot);
      return structuredClone(message);
    });
  }

  updateMessage(
    threadId: string,
    messageId: string,
    patch: Partial<Pick<ChatMessage, "content" | "status" | "error">>,
  ): Promise<ChatMessage> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      const thread = snapshot.threads.find((item) => item.id === threadId);
      if (!thread) throw new ChatStoreError(`Thread not found: ${threadId}`);
      const message = thread.messages.find((item) => item.id === messageId);
      if (!message) {
        throw new ChatStoreError(`Message not found: ${messageId}`);
      }
      if (patch.content !== undefined) message.content = patch.content;
      if (patch.status !== undefined) message.status = patch.status;
      if (patch.error !== undefined) message.error = patch.error;
      if (patch.error === null as unknown as string) delete message.error;
      message.updatedAt = nowIso();
      thread.updatedAt = message.updatedAt;
      await this.writeSnapshot(snapshot);
      return structuredClone(message);
    });
  }

  private async readSnapshot(): Promise<ChatStoreSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new ChatStoreError(
          `Chat storage is missing at ${this.indexPath}. Restart the app to recreate it.`,
        );
      }
      throw new ChatStoreError(
        `Unable to read chat storage: ${(error as Error).message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ChatStoreError(
        `Chat storage at ${this.indexPath} is corrupt JSON. Move or delete that file and relaunch.`,
      );
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as ChatStoreSnapshot).version !== STORE_VERSION ||
      !Array.isArray((parsed as ChatStoreSnapshot).threads)
    ) {
      throw new ChatStoreError(
        `Chat storage at ${this.indexPath} has an unsupported shape. Move or delete that file and relaunch.`,
      );
    }

    return parsed as ChatStoreSnapshot;
  }

  private async writeSnapshot(snapshot: ChatStoreSnapshot): Promise<void> {
    // Never persist credentials — only thread/message fields from the typed model.
    const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
    const tempPath = path.join(
      this.rootDir,
      `.threads.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.indexPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new ChatStoreError(
        `Unable to write chat storage: ${(error as Error).message}`,
      );
    }
  }
}
