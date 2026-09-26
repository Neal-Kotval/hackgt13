import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatStore, ChatStoreError } from "../electron/chat-store.ts";

async function withStore(
  run: (store: ChatStore, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcloud-chat-"));
  try {
    const store = new ChatStore(dir);
    await store.init();
    await run(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("create thread assigns id and empty messages", async () => {
  await withStore(async (store) => {
    const thread = await store.createThread();
    assert.equal(typeof thread.id, "string");
    assert.equal(thread.title, "New chat");
    assert.deepEqual(thread.messages, []);
  });
});

test("messages survive reload from the same directory", async () => {
  await withStore(async (store, dir) => {
    const thread = await store.createThread();
    await store.appendMessage(thread.id, {
      role: "user",
      content: "hello persistence",
    });
    await store.appendMessage(thread.id, {
      role: "assistant",
      content: "persisted reply",
      status: "complete",
    });

    const reloaded = new ChatStore(dir);
    await reloaded.init();
    const listed = await reloaded.listThreads();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.title, "hello persistence");
    const full = await reloaded.getThread(thread.id);
    assert.equal(full?.messages.length, 2);
    assert.equal(full?.messages[1]?.content, "persisted reply");
  });
});

test("list returns recent-first order", async () => {
  await withStore(async (store) => {
    const first = await store.createThread();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await store.createThread();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.appendMessage(first.id, {
      role: "user",
      content: "older thread bumped",
    });
    const listed = await store.listThreads();
    assert.equal(listed[0]?.id, first.id);
    assert.equal(listed[1]?.id, second.id);
    assert.ok(listed[0]!.updatedAt >= listed[1]!.updatedAt);
  });
});

test("delete removes the thread with no leftover orphan payload", async () => {
  await withStore(async (store, dir) => {
    const thread = await store.createThread();
    await store.appendMessage(thread.id, {
      role: "user",
      content: "to delete",
    });
    await store.deleteThread(thread.id);
    assert.equal(await store.getThread(thread.id), null);
    const raw = await readFile(path.join(dir, "threads.json"), "utf8");
    assert.equal(JSON.parse(raw).threads.length, 0);
  });
});

test("corrupt storage fails with a clear error", async () => {
  await withStore(async (_store, dir) => {
    await writeFile(path.join(dir, "threads.json"), "{not-json", "utf8");
    const broken = new ChatStore(dir);
    await assert.rejects(() => broken.listThreads(), (error: unknown) => {
      assert.ok(error instanceof ChatStoreError);
      assert.match(error.message, /corrupt JSON/i);
      return true;
    });
  });
});

test("chat files do not contain api key fields", async () => {
  await withStore(async (store, dir) => {
    const thread = await store.createThread();
    await store.appendMessage(thread.id, {
      role: "user",
      content: "no secrets here",
    });
    const raw = await readFile(path.join(dir, "threads.json"), "utf8");
    assert.doesNotMatch(raw, /api[_-]?key/i);
    assert.doesNotMatch(raw, /OPENAI/i);
    assert.doesNotMatch(raw, /token/i);
  });
});
