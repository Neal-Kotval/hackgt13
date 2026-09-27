import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ssh2 from "ssh2";
import { CliBridge } from "../electron/cli-bridge.ts";
import { generateDeviceKey } from "../electron/device-key.ts";
import { TerminalSessions } from "../electron/terminal-sessions.ts";

for (const mismatch of [false, true]) {
  test(`CLI bridge and real SSH server: ${mismatch ? "reject changed host key" : "authenticate, request PTY, carry terminal data"}`, { timeout: 15_000 }, async () => {
    const host = generateDeviceKey();
    const device = generateDeviceKey();
    const parsed = ssh2.utils.parseKey(device.privateKey);
    assert.ok(!(parsed instanceof Error));
    const connections = new Set<ssh2.Connection>();
    let authenticated = false;
    let pty = false;
    const server = new ssh2.Server({ hostKeys: [host.privateKey] }, (client) => {
      connections.add(client);
      client.on("error", () => {});
      client.on("close", () => connections.delete(client));
      client.on("authentication", (ctx) => {
        if (ctx.method !== "publickey" || ctx.username !== "agentcloud" || !ctx.key.data.equals(parsed.getPublicSSH())) return ctx.reject();
        if (ctx.signature && !verify(null, ctx.blob!, parsed.getPublicPEM(), ctx.signature)) return ctx.reject();
        authenticated = Boolean(ctx.signature);
        ctx.accept();
      });
      client.on("ready", () => client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept, _reject, info) => { pty = info.cols === 91 && info.rows === 27; accept(); });
        session.on("shell", (accept) => {
          const stream = accept();
          stream.write("REMOTE_READY\n");
          stream.on("data", (data: Buffer) => {
            stream.write(`REMOTE_ECHO:${data.toString()}`);
            stream.exit(0);
            stream.end();
          });
        });
      }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as net.AddressInfo;
    const directory = await mkdtemp(path.join(os.tmpdir(), "alto-real-ssh-"));
    // macOS Unix sockets have short path limits; mkdtemp under /tmp is sufficient.
    const socketPath = path.join(directory, "cli.sock");
    let registration = false;
    const sessions = new TerminalSessions({
      beforeConnect: async () => { registration = true; },
      privateKey: () => device.privateKey,
      request: async () => new Response(JSON.stringify({ host: "127.0.0.1", port: address.port,
        username: "agentcloud", hostPublicKey: mismatch ? generateDeviceKey().publicKey : host.publicKey })),
    });
    const bridge = new CliBridge({ terminals: sessions, signedIn: () => true, socketPath });
    let socket: net.Socket | undefined;
    try {
      await bridge.start();
      socket = net.createConnection(socketPath);
      await once(socket, "connect");
      let buffered = "";
      let output = "";
      let failure = "";
      const completed = new Promise<void>((resolve, reject) => {
        socket!.on("error", reject);
        socket!.on("data", (chunk) => {
          buffered += chunk.toString();
          let newline;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const event = JSON.parse(buffered.slice(0, newline));
            buffered = buffered.slice(newline + 1);
            if (event.type === "ready") socket!.write(JSON.stringify({ type: "input", data: "hello\n" }) + "\n");
            if (event.type === "data") output += event.data;
            if (event.type === "error") { failure = event.message; resolve(); }
            if (event.type === "closed") resolve();
          }
        });
      });
      socket.write(JSON.stringify({ type: "open", runBoxId: "environment-test", cols: 91, rows: 27 }) + "\n");
      await completed;
      assert.equal(registration, true);
      if (mismatch) {
        assert.match(failure, /host key|pinned key/i);
        assert.equal(authenticated, false);
        assert.equal(output, "");
      } else {
        assert.equal(failure, "");
        assert.equal(authenticated, true);
        assert.equal(pty, true);
        assert.match(output, /REMOTE_READY/);
        assert.match(output, /REMOTE_ECHO:hello/);
      }
      assert.ok(!output.includes(device.privateKey));
    } finally {
      socket?.destroy();
      await bridge.stop();
      sessions.closeAll();
      for (const client of connections) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
