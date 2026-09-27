import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isChatGptVerificationUrl, parseDeviceLogin } from "../src/lib/chatgpt-sign-in.ts";

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
