import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliBridge } from "../electron/cli-bridge.ts";
import { TerminalSessions } from "../electron/terminal-sessions.ts";

async function fixture(signedIn = false) {
  const root = await mkdtemp(path.join(tmpdir(), "alto-cli-"));
  const socketPath = path.join(root, "private", "desktop.sock");
  const terminals = new TerminalSessions({ request: async () => { throw new Error("must not request"); }, privateKey: () => { throw new Error("must not decrypt"); } });
  const bridge = new CliBridge({ socketPath, terminals, signedIn: () => signedIn });
  await bridge.start();
  return { bridge, root, socketPath, async cleanup() { await bridge.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("bridge restricts filesystem access and rejects signed-out clients", async () => {
  const f = await fixture();
  try {
    assert.equal((await lstat(path.dirname(f.socketPath))).mode & 0o777, 0o700);
    assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600);
    const socket = createConnection(f.socketPath);
    await once(socket, "connect");
    const response = once(socket, "data");
    socket.write(JSON.stringify({ type: "open", runBoxId: "box-123", cols: 80, rows: 24 }) + "\n");
    assert.match(String((await response)[0]), /Sign in to the alto desktop app first/);
    socket.destroy();
  } finally { await f.cleanup(); }
});

test("bridge rejects malformed or oversized frames and disconnects active clients", async () => {
  const f = await fixture();
  try {
    for (const text of ["not json\n", "x".repeat(256 * 1024 + 1)]) {
      const socket = createConnection(f.socketPath);
      await once(socket, "connect");
      const response = once(socket, "data");
      socket.write(text);
      assert.match(String((await response)[0]), /error/);
      socket.destroy();
    }
    const socket = createConnection(f.socketPath);
    await once(socket, "connect");
    const closed = once(socket, "close");
    f.bridge.disconnectAll();
    await closed;
  } finally { await f.cleanup(); }
});

test("bridge refuses an existing regular file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alto-cli-"));
  try {
    const socketPath = path.join(root, "desktop.sock");
    await writeFile(socketPath, "keep");
    const bridge = new CliBridge({ socketPath, terminals: {} as TerminalSessions, signedIn: () => true });
    await assert.rejects(bridge.start(), /unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI provides help and actionable usage/TTY/install errors", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL("../cli/alto.mjs", import.meta.url)), ...args], { encoding: "utf8", env: { ...process.env, ALTO_LAUNCHER_PATH: "" } });
  assert.match(run(["--help"]).stdout, /alto ssh/);
  assert.equal(run(["ssh"]).status, 2);
  const nonTty = run(["ssh", "box-1"]);
  assert.equal(nonTty.status, 2);
  assert.match(nonTty.stderr, /interactive terminal/);
  assert.match(run(["install"]).stderr, /installed desktop app/);
});
