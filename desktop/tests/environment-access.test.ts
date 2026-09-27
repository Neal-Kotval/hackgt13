import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DesktopAuthClient } from "../electron/auth-client.ts";
import { encodeOpenSshPublicKey } from "../electron/device-key.ts";
import {
  ACCESS_MESSAGES,
  createIpv4Fetch,
  ensureEnvironmentAccess,
  EnvironmentAccessError,
} from "../electron/environment-access.ts";
import { SessionStore } from "../electron/session-store.ts";
import { TerminalSessions } from "../electron/terminal-sessions.ts";
import { ENVIRONMENT_ACCESS_PENDING, environmentAccessLabel } from "../src/lib/environment-access.ts";
import type { TerminalEvent } from "../src/lib/types.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function scripted(responses: Response[]) {
  const calls: Array<{ path: string; method: string }> = [];
  return {
    calls,
    request: async (requestPath: string, init: RequestInit = {}) => {
      calls.push({ path: requestPath, method: init.method || "GET" });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return next;
    },
  };
}

describe("IPv4-only registration transport", () => {
  it("pins lookup to IPv4 and disables family auto-selection", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fake = ((url: URL, options: Record<string, unknown>, callback: (res: http.IncomingMessage) => void) => {
      seen.push({ url: url.href, ...options });
      const res = Object.assign(new PassThrough(), { statusCode: 202, headers: { "content-type": "application/json" } });
      queueMicrotask(() => {
        callback(res as unknown as http.IncomingMessage);
        res.end(JSON.stringify({ status: "pending" }));
      });
      return Object.assign(new EventEmitter(), { write() {}, end() {}, destroy() {} });
    }) as unknown as typeof http.request;
    const ipv4 = createIpv4Fetch({ http: fake, https: fake });
    const response = await ipv4("https://agentcloud.example/api/run-boxes/x/ssh-access", {
      method: "POST",
      headers: { cookie: "session=1", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "pending" });
    assert.equal(seen[0].family, 4);
    assert.equal(seen[0].autoSelectFamily, false);
    assert.equal(seen[0].method, "POST");
    assert.equal((seen[0].headers as Record<string, string>).cookie, "session=1");
  });

  it("reaches a server over IPv4 through a hostname", async () => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ family: req.socket.remoteFamily, method: req.method }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const response = await createIpv4Fetch()(`http://localhost:${port}/x`, { method: "GET" });
      assert.deepEqual(await response.json(), { family: "IPv4", method: "GET" });
    } finally {
      server.close();
    }
  });

  it("the desktop auth client sends the employee session over the given transport", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentcloud-access-"));
    dirs.push(dir);
    const store = new SessionStore(dir, {
      isEncryptionAvailable: () => false,
      encryptString: (plain: string) => Buffer.from(plain),
      decryptString: (encrypted: Buffer) => encrypted.toString(),
    });
    let defaultCalls = 0;
    const client = new DesktopAuthClient(store, {
      baseUrl: "https://agentcloud.example",
      fetchImpl: async () => {
        defaultCalls += 1;
        return json(200, {});
      },
    });
    const seen: Array<{ url: string; origin: string | null }> = [];
    const transport = (async (url: string, init: RequestInit) => {
      seen.push({ url, origin: new Headers(init.headers).get("origin") });
      return json(202, { status: "pending" });
    }) as typeof fetch;
    const response = await client.fetchHuman("/api/run-boxes/job/ssh-access", { method: "POST" }, transport);
    assert.equal(response.status, 202);
    assert.equal(defaultCalls, 0);
    assert.deepEqual(seen, [{ url: "https://agentcloud.example/api/run-boxes/job/ssh-access", origin: "https://agentcloud.example" }]);
  });
});

describe("ensureEnvironmentAccess", () => {
  const fast = () => {
    let clock = 0;
    return { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
  };

  it("returns at once when this network is already admitted", async () => {
    const api = scripted([json(200, { status: "applied", cidr: "203.0.113.5/32" })]);
    let pending = 0;
    assert.equal(await ensureEnvironmentAccess(api.request, "job-1", () => { pending += 1; }, fast()), "applied");
    assert.equal(pending, 0);
    assert.deepEqual(api.calls, [{ path: "/api/run-boxes/job-1/ssh-access", method: "POST" }]);
  });

  it("reports pending once and polls until the worker applies the rule", async () => {
    const api = scripted([
      json(202, { status: "pending" }),
      json(200, { sshAccess: { status: "pending" } }),
      json(200, { sshAccess: { status: "applied" } }),
    ]);
    let pending = 0;
    assert.equal(await ensureEnvironmentAccess(api.request, "job-1", () => { pending += 1; }, fast()), "applied");
    assert.equal(pending, 1);
    assert.deepEqual(api.calls.map((call) => call.method), ["POST", "GET", "GET"]);
  });

  it("maps no_ipv4, failure, timeout, and unreachable to clear messages", async () => {
    await assert.rejects(
      ensureEnvironmentAccess(scripted([json(409, { code: "no_ipv4", error: "x" })]).request, "job-1", () => {}, fast()),
      (error: EnvironmentAccessError) => error.code === "no_ipv4" && error.message === ACCESS_MESSAGES.noIpv4,
    );
    await assert.rejects(
      ensureEnvironmentAccess(scripted([json(202, {}), json(200, { sshAccess: { status: "failed" } })]).request, "job-1", () => {}, fast()),
      (error: EnvironmentAccessError) => error.code === "failed" && error.message === ACCESS_MESSAGES.failed,
    );
    const forever = { request: async () => json(200, { sshAccess: { status: "pending" } }) };
    const first = scripted([json(202, {})]);
    let used = false;
    await assert.rejects(
      ensureEnvironmentAccess(async (p, i) => (used ? forever.request() : ((used = true), first.request(p, i))), "job-1", () => {}, fast()),
      (error: EnvironmentAccessError) => error.code === "timeout" && error.message === ACCESS_MESSAGES.timeout,
    );
    await assert.rejects(
      ensureEnvironmentAccess(async () => { throw new TypeError("fetch failed"); }, "job-1", () => {}, fast()),
      (error: EnvironmentAccessError) => error.code === "unreachable",
    );
  });

  it("connects as before when the server does not read requester addresses", async () => {
    const api = scripted([json(409, { code: "address_untrusted" })]);
    assert.equal(await ensureEnvironmentAccess(api.request, "job-1", () => {}, fast()), "not-managed");
  });

  it("labels the pending state for the UI", () => {
    assert.equal(environmentAccessLabel("pending"), ENVIRONMENT_ACCESS_PENDING);
    assert.equal(ENVIRONMENT_ACCESS_PENDING, "Allowing this Mac's network to reach the environment…");
  });
});

describe("terminal sessions and environment access", () => {
  const hostPublicKey = encodeOpenSshPublicKey(Buffer.alloc(32, 3));
  function sessions(profileId: string | null, ensure: (runBoxId: string, onPending: () => void) => Promise<unknown>) {
    const order: string[] = [];
    const terminal = new TerminalSessions({
      request: async () => json(200, { host: "198.51.100.7", port: 22, username: "agentcloud", hostPublicKey, profileId }),
      privateKey: () => "PRIVATE",
      ensureAccess: async (runBoxId, onPending) => {
        order.push(`access:${runBoxId}`);
        return ensure(runBoxId, onPending);
      },
      open: async () => {
        order.push("ssh");
        return { write() {}, resize() {}, close() {} };
      },
    });
    return { terminal, order };
  }

  it("admits this network before SSH for aws-cpu and reports the pending state", async () => {
    const { terminal, order } = sessions("aws-cpu", async (_id, onPending) => { onPending(); });
    const events: TerminalEvent[] = [];
    await terminal.open(1, (event) => events.push(event), "session-0101", "job1", { cols: 80, rows: 24 });
    assert.deepEqual(order, ["access:job1", "ssh"]);
    assert.deepEqual(events, [{ type: "access", sessionId: "session-0101", state: "pending" }]);
  });

  it("does not open SSH when access fails", async () => {
    const { terminal, order } = sessions("aws-cpu", async () => {
      throw new EnvironmentAccessError(ACCESS_MESSAGES.noIpv4, "no_ipv4");
    });
    await assert.rejects(terminal.open(1, () => {}, "session-0102", "job1", { cols: 80, rows: 24 }), /public IPv4/);
    assert.deepEqual(order, ["access:job1"]);
  });

  it("leaves other environments unchanged", async () => {
    for (const profileId of ["local-docker-sandbox", null]) {
      const { terminal, order } = sessions(profileId, async () => {});
      await terminal.open(1, () => {}, `session-02${profileId ? "01" : "02"}`, "job1", { cols: 80, rows: 24 });
      assert.deepEqual(order, ["ssh"]);
    }
  });
});
