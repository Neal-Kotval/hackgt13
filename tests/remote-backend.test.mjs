import test from "node:test";
import assert from "node:assert/strict";
import { remoteBackendURL, proxyRemoteRequest, remoteFetch } from "../lib/remote-backend.mjs";

const upstream = "https://shared.example.test";
function request(path = "/api/state", options = {}) {
  return new Request(`http://127.0.0.1:3000${path}`, { ...options, headers: { host: "127.0.0.1:3000", ...options.headers } });
}

test("remote bridge isolates sessions and guards the loopback browser boundary", async (t) => {
  const previous = process.env.AGENTCLOUD_REMOTE_BACKEND_URL;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.AGENTCLOUD_REMOTE_BACKEND_URL;
    else process.env.AGENTCLOUD_REMOTE_BACKEND_URL = previous;
  });
  delete process.env.AGENTCLOUD_REMOTE_BACKEND_URL;
  assert.equal(remoteBackendURL(), null);
  assert.equal(await proxyRemoteRequest(request()), null);
  for (const value of ["http://shared.example.test", "https://user:pass@shared.example.test", `${upstream}/api`, `${upstream}?a=1`]) {
    process.env.AGENTCLOUD_REMOTE_BACKEND_URL = value;
    assert.throws(remoteBackendURL);
  }
  process.env.AGENTCLOUD_REMOTE_BACKEND_URL = upstream;
  let calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { headers: {
      "content-type": "application/json",
      "set-cookie": "__Secure-better-auth.session_token=remote-session; Path=/; Secure; HttpOnly; SameSite=Lax",
    } });
  };
  for (const headers of [
    { host: "evil.test" },
    { origin: "https://evil.test" },
    { "sec-fetch-site": "cross-site" },
    { origin: "http://localhost:3000" },
    { host: "127.0.0.1:3000@evil.test" },
  ]) {
    assert.equal((await proxyRemoteRequest(request("/api/state", { headers }))).status, 403);
  }
  assert.equal((await proxyRemoteRequest(request("/api/state", { method: "POST", body: "{}" }))).status, 403);
  assert.equal(calls.length, 0);

  const response = await proxyRemoteRequest(request("/api/auth/sign-in/email", {
    method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json", cookie: "better-auth.session_token=local-secret; random=private", authorization: "Bearer must-not-leak" }, body: "{}",
  }));
  const cookie = response.headers.getSetCookie()[0];
  assert.match(cookie, /^agentcloud_remote_[a-f0-9]{24}___Secure-better-auth.session_token=remote-session;/);
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(cookie, /; Secure/);
  assert.equal(calls[0].init.headers.get("cookie"), null);
  assert.equal(calls[0].init.headers.get("authorization"), null);
  assert.equal(calls[0].init.headers.get("origin"), upstream);
  assert.equal(calls[0].init.redirect, "manual");
  const incoming = new Headers({ host: "127.0.0.1:3000", cookie: `${cookie.split(";")[0]}; better-auth.session_token=local-secret` });
  await remoteFetch("/api/employee", incoming);
  assert.equal(calls.at(-1).init.headers.get("cookie"), "__Secure-better-auth.session_token=remote-session");
  assert.equal(calls.at(-1).init.cache, "no-store");
  await assert.rejects(remoteFetch("https://evil.test/api/state", incoming));
  await assert.rejects(remoteFetch("/api/state", new Headers({ host: "public.example.test" })));
  process.env.AGENTCLOUD_REMOTE_BACKEND_URL = "https://other.example.test";
  await remoteFetch("/api/employee", incoming);
  assert.equal(calls.at(-1).init.headers.get("cookie"), null);
  process.env.AGENTCLOUD_REMOTE_BACKEND_URL = upstream;

  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const headers = new Headers({ location: `${upstream}/sign-in?verified=1` });
    headers.append("set-cookie", "__Secure-better-auth.session_token=; Max-Age=0; Secure; Path=/");
    headers.append("set-cookie", "unrelated=secret; Path=/");
    return new Response(null, { status: 302, headers });
  };
  const redirect = await proxyRemoteRequest(request("/api/auth/verify-email?callbackURL=http%3A%2F%2F127.0.0.1%3A3000%2Fsign-in"));
  assert.equal(calls.at(-1).url.searchParams.get("callbackURL"), `${upstream}/sign-in`);
  assert.equal(redirect.headers.get("location"), "http://127.0.0.1:3000/sign-in?verified=1");
  assert.equal(redirect.headers.getSetCookie().length, 1);
  assert.match(redirect.headers.getSetCookie()[0], /Max-Age=0/);
  await proxyRemoteRequest(request("/api/auth/send-verification-email", { method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify({ callbackURL: "/sign-in", email: "a@example.test" }) }));
  assert.equal(JSON.parse(calls.at(-1).init.body).callbackURL, `${upstream}/sign-in`);
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://evil.test/stolen" } });
  assert.equal((await proxyRemoteRequest(request())).status, 502);

  globalThis.fetch = async () => { throw new Error("upstream offline"); };
  const unavailable = await proxyRemoteRequest(request());
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), { error: "Shared backend is unavailable" });
  await assert.rejects(remoteFetch("/api/employee", incoming), /upstream offline/);

  let cancelled = false;
  let upstreamSignal;
  globalThis.fetch = async (_url, init) => {
    upstreamSignal = init.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: live\n\n")); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const controller = new AbortController();
  const streamRequest = request("/api/events", { signal: controller.signal });
  const stream = await proxyRemoteRequest(streamRequest);
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: live\n\n");
  assert.equal(upstreamSignal, streamRequest.signal);
  await reader.cancel();
  assert.equal(cancelled, true);
  controller.abort();
  assert.equal(upstreamSignal.aborted, true);
});
