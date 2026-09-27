import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserLoginCallbackPort,
  isChatGptVerificationUrl,
  parseBrowserLogin,
  parseDeviceLogin,
} from "../src/lib/chatgpt-sign-in.ts";

describe("ChatGPT verification URL guard", () => {
  it("accepts only https://auth.openai.com/ URLs", () => {
    assert.equal(isChatGptVerificationUrl("https://auth.openai.com/codex/device"), true);
    for (const bad of [
      "http://auth.openai.com/codex/device",
      "https://auth.openai.com.evil.test/codex/device",
      "https://auth.openai.com@evil.test/",
      "https://user:pass@auth.openai.com/codex/device",
      "https://evil.test/?u=https://auth.openai.com/",
      "https://auth.openai.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "",
      42,
      null,
    ]) assert.equal(isChatGptVerificationUrl(bad), false, String(bad));
  });

  it("parses the login route payload only when the URL and code are safe", () => {
    assert.deepEqual(parseDeviceLogin({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }), {
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
    assert.equal(parseDeviceLogin({ verificationUrl: "https://evil.test/", userCode: "ABCD-1234" }), null);
    assert.equal(parseDeviceLogin({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "<script>" }), null);
    assert.equal(parseDeviceLogin(undefined), null);
  });
});

describe("ChatGPT browser sign-in guard (HAC-161)", () => {
  const url = (redirect: string, origin = "https://auth.openai.com") =>
    `${origin}/oauth/authorize?client_id=app_x&redirect_uri=${encodeURIComponent(redirect)}&state=s&code_challenge=c`;
  const ok = url("http://localhost:1455/auth/callback");

  it("accepts the Codex authorize URL for ports 1455 and 1457", () => {
    assert.equal(browserLoginCallbackPort(ok), 1455);
    assert.equal(browserLoginCallbackPort(url("http://localhost:1457/auth/callback")), 1457);
    assert.deepEqual(parseBrowserLogin({ method: "browser", authUrl: ok, callbackPort: 1455, loginId: "abc-1" }), {
      method: "browser", authUrl: ok, callbackPort: 1455, loginId: "abc-1",
    });
  });

  it("rejects other hosts, ports, paths and mismatched callback ports", () => {
    for (const bad of [
      url("http://localhost:1455/auth/callback", "https://auth.openai.com.evil.test"),
      url("http://localhost:1455/auth/callback", "http://auth.openai.com"),
      url("http://localhost:22/auth/callback"),
      url("http://127.0.0.1:1455/auth/callback"),
      url("http://localhost:1455/elsewhere"),
      url("http://evil.test:1455/auth/callback"),
      "https://auth.openai.com/oauth/authorize",
      42,
    ]) assert.equal(browserLoginCallbackPort(bad), null, String(bad));
    assert.equal(parseBrowserLogin({ method: "browser", authUrl: ok, callbackPort: 1457, loginId: "a" }), null);
    assert.equal(parseBrowserLogin({ method: "deviceCode", authUrl: ok, callbackPort: 1455, loginId: "a" }), null);
    assert.equal(parseBrowserLogin({ method: "browser", authUrl: ok, callbackPort: 1455, loginId: "a b" }), null);
  });
});
