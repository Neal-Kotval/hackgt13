import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAddTaskPayload } from "../src/lib/add-task.ts";

describe("buildAddTaskPayload", () => {
  it("folds instructions into title for today's API", () => {
    const payload = buildAddTaskPayload({
      projectId: "p1",
      title: "GPU smoke",
      instructions: "Run nvidia-smi and report",
      agentId: "a1",
    });
    assert.deepEqual(payload, {
      type: "addTask",
      projectId: "p1",
      title: "GPU smoke — Run nvidia-smi and report",
      owner: "a1",
    });
  });

  it("rejects empty fields", () => {
    assert.throws(() =>
      buildAddTaskPayload({
        projectId: "p1",
        title: " ",
        instructions: "x",
        agentId: "a1",
      }),
    );
    assert.throws(() =>
      buildAddTaskPayload({
        projectId: "p1",
        title: "t",
        instructions: "",
        agentId: "a1",
      }),
    );
  });

  it("truncates to 200 characters", () => {
    const payload = buildAddTaskPayload({
      projectId: "p1",
      title: "T",
      instructions: "x".repeat(300),
      agentId: "a1",
    });
    assert.equal(payload.title.length, 200);
  });
});
