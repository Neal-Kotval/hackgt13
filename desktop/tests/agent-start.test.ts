import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_START_UNAVAILABLE_REASON,
  describeAgentStartAvailability,
} from "../src/lib/agent-start.ts";

describe("describeAgentStartAvailability", () => {
  it("requires a created task", () => {
    assert.equal(
      describeAgentStartAvailability({
        environmentId: "e1",
        environmentStatus: "verified",
      }).reason,
      "Select a created task before requesting agent start.",
    );
  });

  it("requires a verified environment even when selected", () => {
    assert.match(
      describeAgentStartAvailability({
        taskId: "t1",
        environmentId: "e1",
        environmentStatus: "registered",
      }).reason,
      /verified/i,
    );
  });

  it("stays unavailable when selection is otherwise ready", () => {
    const result = describeAgentStartAvailability({
      taskId: "t1",
      environmentId: "e1",
      environmentStatus: "verified",
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, AGENT_START_UNAVAILABLE_REASON);
  });
});
