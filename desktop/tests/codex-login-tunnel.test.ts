/**
 * ChatGPT browser sign-in tunnel (HAC-161) against an in-process ssh2 server
 * that plays the environment's sshd. It checks the pinned host key and device
 * key, and answers direct-tcpip by connecting to a local "callback" server.
 */
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import ssh2 from "ssh2";
import type { AddressInfo } from "node:net";
import { encodeOpenSshPublicKey, generateDeviceKey } from "../electron/device-key.ts";
import {
  CodexLoginTunnels,
  FORWARD_REFUSED_MESSAGE,
  LISTENER_MISSING_MESSAGE,
  openLoginTunnel,
  portInUseMessage,
  TIMEOUT_MESSAGE,
  TUNNEL_CLOSED_MESSAGE,
  UNREACHABLE_MESSAGE,
  type LoginTunnelEvent,
  type SshForwarder,
} from "../electron/codex-login-tunnel.ts";
import { HOST_KEY_MISMATCH_MESSAGE, NO_AUTHORIZED_KEY_MESSAGE } from "../electron/ssh-terminal.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hostKey = generateDeviceKey();
const deviceKey = generateDeviceKey();
const allowedBlob = Buffer.from(deviceKey.publicKey.split(" ")[1], "base64");

type FakeSshd = { port: number; requests: Array<{ destIP: string; destPort: number }>; clients: Set<ssh2.Connection>; close: () => Promise<void> };

/** A fake environment sshd. direct-tcpip is answered by connecting to `targetPort` on this machine. */
function startFakeSshd(targetPort: () => number, options: { refuseForward?: "prohibited" | "connect-failed" } = {}): Promise<FakeSshd> {
  const requests: FakeSshd["requests"] = [];
  const clients = new Set<ssh2.Connection>();
  const server = new ssh2.Server({ hostKeys: [hostKey.privateKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "publickey" && Buffer.compare(ctx.key.data, allowedBlob) === 0) ctx.accept();
      else ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      // With no tcpip listener ssh2 answers ADMINISTRATIVELY_PROHIBITED, like sshd with AllowTcpForwarding no.
      if (options.refuseForward === "prohibited") return;
      client.on("tcpip", (accept, reject, info) => {
        requests.push({ destIP: info.destIP, destPort: info.destPort });
        if (options.refuseForward) {
          reject();
          return;
        }
        const channel = accept();
        const upstream = net.connect(targetPort(), "127.0.0.1");
        upstream.on("error", () => channel.destroy());
        channel.on("error", () => upstream.destroy());
        channel.pipe(upstream).pipe(channel);
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        clients,
        close: () =>
          new Promise<void>((done) => {
            for (const client of clients) client.end();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Stand-in for Codex's callback server: answers any HTTP request with a fixed body. */
function startCallbackServer(): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function httpGet(port: number, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    let data = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

function canConnect(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const nonLoopbackIPv4 = Object.values(os.networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;

describe("openLoginTunnel over a fake environment sshd", () => {
  let callback: net.Server;
  let sshd: FakeSshd;
  before(async () => {
    callback = await startCallbackServer();
    sshd = await startFakeSshd(() => (callback.address() as AddressInfo).port);
  });
  after(async () => {
    await sshd.close();
    callback.close();
  });
  const connection = () => ({
    host: "127.0.0.1",
    port: sshd.port,
    username: "agentcloud",
    hostPublicKey: hostKey.publicKey,
    privateKey: deviceKey.privateKey,
  });

  it("listens on loopback only and forwards bytes to 127.0.0.1:<port> on the environment", async () => {
    const listenPort = await freePort();
    let closedWith: string | undefined | null = null;
    const tunnel = await openLoginTunnel({ connection: connection(), listenPort, remotePort: 1455, onClose: (error) => (closedWith = error) });
    try {
      assert.equal(tunnel.port, listenPort);
      const response = await httpGet(listenPort);
      assert.match(response, /^HTTP\/1\.1 404 Not Found/);
      assert.match(response, /Not Found$/);
      assert.deepEqual(sshd.requests.at(-1), { destIP: "127.0.0.1", destPort: 1455 });
      if (nonLoopbackIPv4) assert.equal(await canConnect(listenPort, nonLoopbackIPv4), false, "not reachable off-host");
    } finally {
      tunnel.close();
    }
    assert.equal(closedWith, undefined);
    assert.equal(await canConnect(listenPort), false, "port released after close");
  });

  it("maps a busy local port to a clear message before connecting SSH", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const busy = (blocker.address() as AddressInfo).port;
    let connected = false;
    await assert.rejects(
      openLoginTunnel({
        connection: connection(),
        listenPort: busy,
        remotePort: 1455,
        connect: async () => {
          connected = true;
          throw new Error("unreachable");
        },
        onClose: () => {},
      }),
      (error: Error) => error.message === portInUseMessage(busy) && /Port \d+ on this Mac is in use \(is another Codex sign-in running\?\)/.test(error.message),
    );
    assert.equal(connected, false);
    blocker.close();
  });

  it("refuses a wrong pinned host key, an unauthorized device key, and an unreachable host", async () => {
    const listenPort = await freePort();
    const wrong = encodeOpenSshPublicKey(Buffer.alloc(32, 9));
    await assert.rejects(
      openLoginTunnel({ connection: { ...connection(), hostPublicKey: wrong }, listenPort, remotePort: 1455, onClose: () => {} }),
      (error: Error) => error.message === HOST_KEY_MISMATCH_MESSAGE,
    );
    await assert.rejects(
      openLoginTunnel({ connection: { ...connection(), privateKey: generateDeviceKey().privateKey }, listenPort, remotePort: 1455, onClose: () => {} }),
      (error: Error) => error.message === NO_AUTHORIZED_KEY_MESSAGE,
    );
    await assert.rejects(
      openLoginTunnel({ connection: { ...connection(), port: await freePort() }, listenPort, remotePort: 1455, onClose: () => {} }),
      (error: Error) => error.message === UNREACHABLE_MESSAGE,
    );
    assert.equal(await canConnect(listenPort), false, "listener closed after SSH failure");
  });

  for (const [mode, message] of [
    ["prohibited", FORWARD_REFUSED_MESSAGE],
    ["connect-failed", LISTENER_MISSING_MESSAGE],
  ] as const) {
    it(`closes with a clear message when the forward fails (${mode})`, async () => {
      const refusing = await startFakeSshd(() => 1, { refuseForward: mode });
      const listenPort = await freePort();
      let closedWith: string | undefined | null = null;
      const tunnel = await openLoginTunnel({
        connection: { ...connection(), port: refusing.port },
        listenPort,
        remotePort: 1455,
        onClose: (error) => (closedWith = error),
      });
      await httpGet(listenPort).catch(() => "");
      const deadline = Date.now() + 5_000;
      while (closedWith === null && Date.now() < deadline) await sleep(20);
      assert.equal(closedWith, message);
      assert.equal(await canConnect(listenPort), false);
      tunnel.close();
      await refusing.close();
    });
  }

  it("reports the SSH connection dropping", async () => {
    const listenPort = await freePort();
    let closedWith: string | undefined | null = null;
    const tunnel = await openLoginTunnel({ connection: connection(), listenPort, remotePort: 1455, onClose: (error) => (closedWith = error) });
    for (const client of sshd.clients) client.end();
    const deadline = Date.now() + 5_000;
    while (closedWith === null && Date.now() < deadline) await sleep(20);
    assert.equal(closedWith, TUNNEL_CLOSED_MESSAGE);
    assert.equal(await canConnect(listenPort), false);
    tunnel.close();
  });
});

describe("CodexLoginTunnels lifecycle", () => {
  const SESSION = "11111111-2222-3333-4444-555555555555";
  const authUrl = (port = 1455) =>
    `https://auth.openai.com/oauth/authorize?client_id=app_x&redirect_uri=${encodeURIComponent(`http://localhost:${port}/auth/callback`)}&state=s`;
  const connectionBody = JSON.stringify({ host: "127.0.0.1", port: 22, username: "agentcloud", hostPublicKey: hostKey.publicKey });
  let portFree = true;
  before(async () => {
    portFree = !(await canConnect(1455));
  });

  function fakeForwarder() {
    const listeners: Array<(error?: string) => void> = [];
    let closed = false;
    const forwarder: SshForwarder = {
      // Channels never open in these lifecycle tests; the Mac-side socket just waits.
      forward: () => new Promise<never>(() => {}),
      close: () => {
        closed = true;
      },
      onClose: (listener) => listeners.push(listener),
    };
    return { forwarder, drop: (error?: string) => listeners.forEach((l) => l(error)), get closed() { return closed; } };
  }

  function manager(overrides: Partial<ConstructorParameters<typeof CodexLoginTunnels>[0]> = {}) {
    const opened: string[] = [];
    const events: LoginTunnelEvent[] = [];
    const fake = fakeForwarder();
    const tunnels = new CodexLoginTunnels({
      request: async () => new Response(connectionBody, { status: 200 }),
      privateKey: () => deviceKey.privateKey,
      connect: async () => fake.forwarder,
      openExternal: async (url) => {
        // The browser is opened only once the Mac-side port is listening.
        assert.equal(await canConnect(1455), true);
        opened.push(url);
      },
      ...overrides,
    });
    return { tunnels, opened, events, fake, send: (event: LoginTunnelEvent) => events.push(event) };
  }

  it("refuses bad input without listening or opening a browser", async (t) => {
    if (!portFree) return t.skip("port 1455 is in use on this machine");
    const m = manager();
    const base = { sessionId: SESSION, runBoxId: "rb-1", authUrl: authUrl(), callbackPort: 1455 };
    for (const bad of [
      { ...base, callbackPort: 8080 },
      { ...base, callbackPort: 1457 },
      { ...base, authUrl: "https://evil.test/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" },
      { ...base, authUrl: authUrl().replace("https://", "http://") },
      { ...base, sessionId: "../x" },
    ]) await assert.rejects(m.tunnels.start(1, m.send, bad));
    assert.deepEqual(m.opened, []);
    assert.equal(m.tunnels.size, 0);
  });

  it("opens the browser after listening and closes on completion", async (t) => {
    if (!portFree) return t.skip("port 1455 is in use on this machine");
    const m = manager();
    assert.deepEqual(await m.tunnels.start(1, m.send, { sessionId: SESSION, runBoxId: "rb-1", authUrl: authUrl(), callbackPort: 1455 }), { callbackPort: 1455 });
    assert.deepEqual(m.opened, [authUrl()]);
    m.tunnels.stop(2, SESSION); // another window cannot stop it
    assert.equal(await canConnect(1455), true);
    m.tunnels.stop(1, SESSION);
    assert.equal(m.fake.closed, true);
    assert.equal(await canConnect(1455), false);
    assert.deepEqual(m.events, []);
  });

  it("closes after the timeout and tells the renderer", async (t) => {
    if (!portFree) return t.skip("port 1455 is in use on this machine");
    const m = manager({ timeoutMs: 50 });
    await m.tunnels.start(1, m.send, { sessionId: SESSION, runBoxId: "rb-1", authUrl: authUrl(), callbackPort: 1455 });
    await sleep(150);
    assert.deepEqual(m.events, [{ type: "closed", sessionId: SESSION, error: TIMEOUT_MESSAGE }]);
    assert.equal(await canConnect(1455), false);
    assert.equal(m.tunnels.size, 0);
  });

  it("closes when the window goes away and reports an SSH drop", async (t) => {
    if (!portFree) return t.skip("port 1455 is in use on this machine");
    const m = manager();
    await m.tunnels.start(7, m.send, { sessionId: SESSION, runBoxId: "rb-1", authUrl: authUrl(), callbackPort: 1455 });
    m.tunnels.closeOwner(7);
    assert.equal(await canConnect(1455), false);
    assert.deepEqual(m.events, []);

    const d = manager();
    await d.tunnels.start(7, d.send, { sessionId: SESSION, runBoxId: "rb-1", authUrl: authUrl(), callbackPort: 1455 });
    d.fake.drop(TUNNEL_CLOSED_MESSAGE);
    assert.deepEqual(d.events, [{ type: "closed", sessionId: SESSION, error: TUNNEL_CLOSED_MESSAGE }]);
    assert.equal(await canConnect(1455), false);
  });

  it("maps a busy port and an unauthorized device key", async (t) => {
    if (!portFree) return t.skip("port 1455 is in use on this machine");
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(1455, "127.0.0.1", () => resolve()));
    const m = manager();
    await assert.rejects(
      m.tunnels.start(1, m.send, { sessionId: SESSION, runBoxId: "rb-1", authUrl: authUrl(), callbackPort: 1455 }),
      (error: Error) => error.message.startsWith("Port 1455 on this Mac is in use (is another Codex sign-in running?)"),
    );
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    assert.deepEqual(m.opened, []);

    const denied = manager({
      request: async () => new Response(JSON.stringify({ error: "No key", code: "no_authorized_key" }), { status: 403 }),
    });
    await assert.rejects(
      denied.tunnels.start(1, denied.send, { sessionId: SESSION, runBoxId: "rb-1", authUrl: authUrl(), callbackPort: 1455 }),
      (error: Error) => error.message === NO_AUTHORIZED_KEY_MESSAGE,
    );
    assert.equal(await canConnect(1455), false);
    assert.equal(denied.tunnels.size, 0);
  });
});
