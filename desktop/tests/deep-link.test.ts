import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findDeepLinkUrl,
  parseAgentCloudDeepLink,
} from "../src/lib/deep-link.ts";

describe("parseAgentCloudDeepLink", () => {
  it("parses open with project and environment", () => {
    const result = parseAgentCloudDeepLink(
      "agentcloud://open?projectId=p1&environmentId=e1",
    );
    assert.deepEqual(result, {
      ok: true,
      target: { projectId: "p1", environmentId: "e1" },
    });
  });

  it("allows project-only open links", () => {
    const result = parseAgentCloudDeepLink("agentcloud://open?projectId=p1");
    assert.deepEqual(result, { ok: true, target: { projectId: "p1" } });
  });

  it("rejects missing projectId", () => {
    const result = parseAgentCloudDeepLink("agentcloud://open?environmentId=e1");
    assert.equal(result.ok, false);
  });

  it("rejects other schemes and actions", () => {
    assert.equal(parseAgentCloudDeepLink("https://example.com").ok, false);
    assert.equal(parseAgentCloudDeepLink("agentcloud://spawn?projectId=p1").ok, false);
  });
});

describe("findDeepLinkUrl", () => {
  it("finds the first agentcloud URL in argv", () => {
    assert.equal(
      findDeepLinkUrl([
        "/path/to/electron",
        "agentcloud://open?projectId=p1",
        "--flag",
      ]),
      "agentcloud://open?projectId=p1",
    );
    assert.equal(findDeepLinkUrl(["/path/to/electron"]), null);
  });
});
