import assert from "node:assert/strict";
import test from "node:test";
import { checkRunpodExpiryGuard, inspectRunpodExpiryGuard } from "../scripts/runpod-expiry-preflight.mjs";

const now = Date.parse("2026-09-26T12:00:00Z");
function fixture(overrides = {}) {
  const values = {
    sts: { Account: "662660921850" },
    lambda: { State: "Active", LastUpdateStatus: "Successful", FunctionArn: "arn:aws:lambda:us-east-1:662660921850:function:agentcloud-runpod-expiry" },
    eventsDescribe: { State: "ENABLED", ScheduleExpression: "rate(5 minutes)" },
    eventsTargets: { Targets: [{ Arn: "arn:aws:lambda:us-east-1:662660921850:function:agentcloud-runpod-expiry" }] },
    ssm: { Parameter: { Value: "2026-09-26T11:55:00Z" } },
    ...overrides,
  };
  return { now, call: async ([service, operation]) => {
    const key = service === "events" ? `events${operation === "describe-rule" ? "Describe" : "Targets"}` : service;
    return values[key];
  } };
}

test("accepts a fresh scan only with an active function and scheduled target", async () => {
  assert.equal(await checkRunpodExpiryGuard(fixture()), true);
});

test("fails closed for stale scan, disabled rule, or missing target", async () => {
  assert.equal(await checkRunpodExpiryGuard(fixture({ ssm: { Parameter: { Value: "2026-09-26T11:49:00Z" } } })), false);
  assert.equal((await inspectRunpodExpiryGuard(fixture({ eventsDescribe: { State: "DISABLED" } }))).reason, "expiry schedule disabled");
  assert.equal((await inspectRunpodExpiryGuard(fixture({ eventsTargets: { Targets: [] } }))).reason, "expiry schedule target missing");
});

test("fails closed when AWS status is unavailable", async () => {
  assert.equal(await checkRunpodExpiryGuard({ call: async () => { throw new Error("credential details"); } }), false);
});
