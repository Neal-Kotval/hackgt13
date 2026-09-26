import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import {
  DesktopAuthClient,
  AuthError,
} from "../electron/auth-client.ts";
import {
  SessionStore,
  mergeCookieHeader,
  cookieLooksLikeSession,
} from "../electron/session-store.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentcloud-auth-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const plainCrypto = {
  isEncryptionAvailable: () => false,
  encryptString: (plain: string) => Buffer.from(plain, "utf8"),
  decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
};

describe("session cookie helpers", () => {
  it("merges Set-Cookie into a Cookie header", () => {
    const merged = mergeCookieHeader(
      "a=1; better-auth.session_token=old",
      [
        "better-auth.session_token=new; Path=/; HttpOnly",
        "b=2; Path=/",
      ],
    );
    assert.equal(merged.includes("better-auth.session_token=new"), true);
    assert.equal(merged.includes("a=1"), true);
    assert.equal(merged.includes("b=2"), true);
    assert.equal(cookieLooksLikeSession(merged), true);
  });
});

describe("SessionStore", () => {
  it("persists and clears outside chat paths", () => {
    const dir = tempDir();
    const store = new SessionStore(dir, plainCrypto);
    store.save({
      cookieHeader: "better-auth.session_token=abc",
      baseUrl: "http://127.0.0.1:3000",
      updatedAt: new Date().toISOString(),
    });
    assert.equal(existsSync(store.path), true);
    assert.equal(store.path.includes("threads.json"), false);
    const loaded = store.load();
    assert.equal(loaded?.cookieHeader, "better-auth.session_token=abc");
    store.clear();
    assert.equal(store.load(), null);
  });
});

describe("DesktopAuthClient", () => {
  it("signs in, attaches cookie to human APIs, rejects Authorization headers", async () => {
    const dir = tempDir();
    const store = new SessionStore(dir, plainCrypto);
    const calls: { url: string; cookie?: string | null; auth?: string | null }[] =
      [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        cookie: headers.get("cookie"),
        auth: headers.get("authorization"),
      });

      if (url.endsWith("/api/auth/sign-in/email")) {
        return new Response(JSON.stringify({ user: { id: "u1" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "better-auth.session_token=sess-a; Path=/; HttpOnly",
          },
        });
      }
      if (url.endsWith("/api/auth/get-session")) {
        return new Response(
          JSON.stringify({
            user: {
              id: "u1",
              name: "Ada",
              email: "ada@example.test",
              emailVerified: true,
            },
            session: { id: "s1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/state")) {
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/sign-out")) {
        return new Response(null, {
          status: 200,
          headers: {
            "set-cookie":
              "better-auth.session_token=; Max-Age=0; Path=/",
          },
        });
      }
      return new Response("missing", { status: 404 });
    };

    const client = new DesktopAuthClient(store, {
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl,
      encryptionAvailable: false,
    });

    const identity = await client.signIn("ada@example.test", "password-long");
    assert.equal(identity.email, "ada@example.test");
    assert.equal(client.hasLocalSession(), true);

    const human = await client.fetchHuman("/api/state");
    assert.equal(human.status, 200);
    assert.equal(
      calls.some(
        (call) =>
          call.url.endsWith("/api/state") &&
          call.cookie === "better-auth.session_token=sess-a" &&
          !call.auth,
      ),
      true,
    );

    await assert.rejects(
      () =>
        client.fetchHuman("/api/state", {
          headers: { Authorization: "Bearer agent-token" },
        }),
      (error: unknown) =>
        error instanceof AuthError &&
        /must not carry Authorization/i.test(error.message),
    );

    await client.signOut();
    assert.equal(client.hasLocalSession(), false);
    assert.equal(store.load(), null);
    // Ensure session file contents never look like chat transcripts.
    assert.equal(existsSync(path.join(dir, "threads.json")), false);
    if (existsSync(store.path)) {
      const raw = readFileSync(store.path, "utf8");
      assert.equal(raw.includes('"role":"user"'), false);
    }
  });

  it("returns 401-style failure path when unsigned human call has no cookie", async () => {
    const dir = tempDir();
    const store = new SessionStore(dir, plainCrypto);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/state")) {
        return new Response(
          JSON.stringify({ error: "Employee sign-in required" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("missing", { status: 404 });
    };
    const client = new DesktopAuthClient(store, {
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl,
    });
    const response = await client.fetchHuman("/api/state");
    assert.equal(response.status, 401);
    assert.equal(client.hasLocalSession(), false);
  });
});
