import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveChatTargets,
  environmentLabel,
  parseCodexSession,
  parseCodexSessions,
  sessionForTarget,
  targetKey,
} from "../src/lib/codex-targets.ts";
import { codexBlockedReason, parseRunBox, parseRunBoxList } from "../src/lib/run-boxes.ts";

function job(id: string, overrides: Record<string, unknown> = {}) {
  return parseRunBox({
    id,
    projectId: "p1",
    provider: "aws-ec2",
    profileId: "aws-cpu",
    state: "ready",
    ssh: { host: "10.0.0.1", port: 22, username: "agentcloud" },
    agent: { codex: { state: "ready", version: "0.157.1", reason: null } },
    ...overrides,
  })!;
}

describe("run-box agent.codex parsing", () => {
  it("reads agent.codex state and tolerates listings without it", () => {
    assert.deepEqual(job("abcdef123456").codex, { state: "ready", reason: null });
    const legacy = parseRunBoxList({ jobs: [{ id: "j1", state: "ready" }] })[0];
    assert.equal(legacy.codex, null);
    assert.match(codexBlockedReason(legacy)!, /not reported a Codex check/);
    assert.equal(job("j2", { agent: { codex: { state: "weird" } } }).codex?.state, "unknown");
  });

  it("explains why Codex cannot target an environment", () => {
    assert.equal(codexBlockedReason(job("j1")), null);
    assert.match(codexBlockedReason(job("j1", { state: "allocating" }))!, /currently allocating/);
    assert.match(codexBlockedReason(job("j1", { agent: { codex: { state: "pending" } } }))!, /still being checked/);
    assert.match(codexBlockedReason(job("j1", { agent: { codex: { state: "failed", reason: "wrong version" } } }))!, /wrong version/);
    assert.match(codexBlockedReason(job("j1", { stopRequestedAt: "2026-01-01" }))!, /Stop was requested/);
  });
});

describe("deriveChatTargets", () => {
  it("offers the local box plus ready environments whose Codex check is ready", () => {
    const targets = deriveChatTargets("p1", [
      job("abcdef123456"),
      job("pending1", { agent: { codex: { state: "pending" } } }),
      job("failed01", { agent: { codex: { state: "failed" } } }),
      job("stopping", { state: "stopping" }),
      job("stopreq1", { stopRequestedAt: "2026-01-01" }),
      job("nocodex1", { agent: undefined }),
      job("otherprj", { projectId: "p2" }),
      job("runpod01", { provider: "runpod", profileId: null }),
    ]);
    assert.deepEqual(targets.map(target => target.key), ["local", "runBox:abcdef123456", "runBox:runpod01"]);
    assert.equal(targets[0].label, "Local Codex box");
    assert.equal(targets[1].label, "AWS EC2 CPU · abcdef12");
    assert.equal(targets[2].label, "Runpod · runpod01");
  });

  it("keeps the current session's environment listed as unavailable after it stops", () => {
    const targets = deriveChatTargets("p1", [], { kind: "runBox", runBoxId: "gone1234", provider: "aws-ec2", profileId: "aws-cpu", state: "stopped" });
    assert.equal(targets.length, 2);
    assert.equal(targets[1].kind === "runBox" && targets[1].available, false);
    assert.match(targets[1].label, /AWS EC2 CPU · gone1234 \(unavailable\)/);
  });

  it("labels unknown providers and profiles honestly", () => {
    assert.equal(environmentLabel("x1", "custom", "big"), "custom big · x1");
    assert.equal(environmentLabel("x1", null, null), "Environment · x1");
  });
});

describe("legacy codex session API shape", () => {
  it("treats sessions without target as local", () => {
    const sessions = parseCodexSessions([
      { id: "s1", projectId: "p1", agentId: "a1", status: "ready", error: null },
      { id: "s2", projectId: "p1", agentId: "a1", status: "auth_required", error: null, target: { kind: "runBox", runBoxId: "j1", provider: "aws-ec2", profileId: "aws-cpu", state: "ready" } },
      { id: "s3", projectId: "p1", agentId: "a1", status: "ready", target: { kind: "runBox" } },
      null,
      { projectId: "p1" },
    ]);
    assert.deepEqual(sessions.map(session => [session.id, targetKey(session.target)]), [["s1", "local"], ["s2", "runBox:j1"], ["s3", "local"]]);
    assert.equal(sessionForTarget(sessions, "local")?.id, "s1");
    assert.equal(sessionForTarget(sessions, "runBox:j1")?.id, "s2");
    assert.equal(sessionForTarget(sessions, "runBox:j9"), undefined);
    assert.deepEqual(parseCodexSessions(undefined), []);
  });

  it("maps an unknown status to error rather than inventing readiness", () => {
    assert.equal(parseCodexSession({ id: "s1", status: "signed_in" })?.status, "error");
  });
});
