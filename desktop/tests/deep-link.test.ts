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

  it("parses open with project and runBoxId", () => {
    const result = parseAgentCloudDeepLink(
      "agentcloud://open?projectId=p1&runBoxId=job-42",
    );
    assert.deepEqual(result, {
      ok: true,
      target: { projectId: "p1", runBoxId: "job-42" },
    });
  });

  it("ignores host and port supplied in the URL", () => {
    const result = parseAgentCloudDeepLink(
      "agentcloud://open?projectId=p1&runBoxId=job-42&host=evil.example&port=2222&hostPublicKey=x",
    );
    assert.deepEqual(result, {
      ok: true,
      target: { projectId: "p1", runBoxId: "job-42" },
    });
  });

  it("rejects malformed runBoxId values", () => {
    const result = parseAgentCloudDeepLink(
      "agentcloud://open?projectId=p1&runBoxId=..%2Fetc",
    );
    assert.equal(result.ok, false);
  });

  it("rejects runBoxId without projectId", () => {
    assert.equal(parseAgentCloudDeepLink("agentcloud://open?runBoxId=j1").ok, false);
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

 describe("Codex deep links", () => {
  it("opens a session only with a project and safe session identifier", () => {
    assert.deepEqual(parseAgentCloudDeepLink("agentcloud://open?projectId=p1&codexSessionId=codex-42"), { ok: true, target: { projectId: "p1", codexSessionId: "codex-42" } });
    for (const query of ["codexSessionId=s1", "projectId=p1&codexSessionId=..%2Fsecret", "projectId=p1&codexSessionId=s1&runBoxId=r1", "projectId=p1&codexSessionId=s1&environmentId=e1"]) {
      assert.equal(parseAgentCloudDeepLink(`agentcloud://open?${query}`).ok, false);
    }
  });
});
