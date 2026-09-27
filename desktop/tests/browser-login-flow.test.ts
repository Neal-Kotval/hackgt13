import assert from "node:assert/strict";
import { test } from "node:test";
import { beginBrowserLogin, type LoginBridge } from "../src/lib/browser-login-flow.ts";

const target = { projectId: "p1", runBoxId: "r1", codexSessionId: "s1" };
const session = (status = "auth_required") => ({ id: "s1", projectId: "p1", status, target: { kind: "runBox", runBoxId: "r1" } });
function fixture(options: { initial?: object; badLogin?: boolean; hold?: Promise<void> } = {}) {
  const calls: string[] = [];
  let reads = 0;
  const bridge: LoginBridge = {
    fetchHuman: async (_path, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push(body?.action || "read");
      if (body?.action === "login") {
        assert.equal(body.method, "browser");
        await options.hold;
        return { ok: true, status: 200, body: JSON.stringify({ login: { method: "browser", authUrl: options.badLogin ? "https://evil.test" : "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback", loginId: "login1", callbackPort: 1455 } }) };
      }
      return { ok: true, status: 200, body: JSON.stringify({ session: ++reads === 1 ? options.initial || session() : session("ready") }) };
    },
    startChatGptBrowserSignIn: async () => { calls.push("tunnel:start"); return { callbackPort: 1455 }; },
    stopChatGptBrowserSignIn: async () => { calls.push("tunnel:stop"); },
    onChatGptSignInEvent: () => () => { calls.push("unsubscribe"); },
  };
  return { bridge, calls };
}
test("authenticated session identity is checked before login", async () => {
  for (const initial of [{ ...session(), projectId: "other" }, { ...session(), id: "other" }, { ...session(), target: { kind: "runBox", runBoxId: "other" } }, { ...session(), target: { kind: "local" } }]) {
    const { bridge, calls } = fixture({ initial }); const errors: string[] = [];
    await beginBrowserLogin(bridge, target, () => {}, () => assert.fail("must not finish"), e => errors.push(e), 1).done;
    assert.match(errors[0], /does not belong/); assert.ok(!calls.includes("login")); assert.ok(!calls.includes("tunnel:start"));
  }
});
test("browser login opens tunnel and closes before completing", async () => {
  const { bridge, calls } = fixture();
  await beginBrowserLogin(bridge, target, () => {}, () => calls.push("complete"), assert.fail, 1).done;
  assert.deepEqual(calls, ["read", "login", "tunnel:start", "read", "unsubscribe", "tunnel:stop", "complete"]);
});
test("ready session never starts another login", async () => {
  const { bridge, calls } = fixture({ initial: session("ready") });
  await beginBrowserLogin(bridge, target, () => {}, () => calls.push("complete"), assert.fail, 1).done;
  assert.ok(calls.includes("complete")); assert.ok(!calls.includes("login"));
});
test("invalid browser URL cancels remote login without opening browser", async () => {
  const { bridge, calls } = fixture({ badLogin: true }); const errors: string[] = [];
  await beginBrowserLogin(bridge, target, () => {}, assert.fail, e => errors.push(e), 1).done;
  assert.match(errors[0], /valid browser/); assert.ok(calls.includes("cancelLogin")); assert.ok(!calls.includes("tunnel:start"));
});
test("unmount while login is pending cancels once response arrives", async () => {
  let release!: () => void;
  const { bridge, calls } = fixture({ hold: new Promise<void>(resolve => { release = resolve; }) });
  const flow = beginBrowserLogin(bridge, target, () => {}, assert.fail, assert.fail, 1);
  while (!calls.includes("login")) await new Promise(resolve => setTimeout(resolve, 1));
  const cancelled = flow.cancel(); release(); await cancelled;
  assert.ok(!calls.includes("tunnel:start")); assert.ok(calls.includes("cancelLogin"));
});
test("web cancellation closes tunnel and stops waiting", async () => {
  const { bridge, calls } = fixture(); const original = bridge.fetchHuman; let reads = 0; const errors: string[] = [];
  bridge.fetchHuman = async (path, options) => {
    if (!options && ++reads > 1) return { ok: true, status: 200, body: JSON.stringify({ session: { ...session(), loginPending: false } }) };
    return original(path, options);
  };
  await beginBrowserLogin(bridge, target, () => {}, assert.fail, e => errors.push(e), 1).done;
  assert.match(errors[0], /cancelled or expired/);
  assert.ok(calls.includes("tunnel:stop")); assert.ok(calls.includes("cancelLogin"));
});

// Live (staging): sign-in started while Codex was still connecting to a fresh GPU environment;
// the request outlasted CloudFront's 30 s limit and JSON.parse hit its HTML error page.
test("waits for Codex to finish connecting, retries a 'connecting' answer, then signs in", async () => {
  const { bridge, calls } = fixture(); const original = bridge.fetchHuman; let reads = 0; let loginAttempts = 0;
  bridge.fetchHuman = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (!body && ++reads <= 2) { calls.push("read"); return { ok: true, status: 200, body: JSON.stringify({ session: session("initializing") }) }; }
    if (body?.action === "login" && ++loginAttempts === 1) {
      calls.push("login");
      return { ok: false, status: 409, body: JSON.stringify({ error: "Codex is still connecting to this environment. Try again in a few seconds.", code: "connecting" }) };
    }
    return original(path, init);
  };
  const errors: string[] = [];
  await beginBrowserLogin(bridge, target, () => {}, () => calls.push("complete"), e => errors.push(e), 1).done;
  assert.deepEqual(errors, []);
  assert.equal(loginAttempts, 2);
  assert.ok(calls.indexOf("tunnel:start") > calls.lastIndexOf("login") - 1 && calls.includes("complete"));
});
test("an HTML error page becomes a readable message instead of a JSON parse error", async () => {
  const { bridge } = fixture();
  bridge.fetchHuman = async () => ({ ok: false, status: 504, body: "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 4.01//EN\"><HTML>504 Gateway Timeout</HTML>" });
  const errors: string[] = [];
  await beginBrowserLogin(bridge, target, () => {}, assert.fail, e => errors.push(e), 1).done;
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /Unexpected token|JSON/);
  assert.match(errors[0], /didn't respond|try again/i);
});
