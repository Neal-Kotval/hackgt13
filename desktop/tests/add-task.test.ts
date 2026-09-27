import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAddTaskPayload } from "../src/lib/add-task.ts";

describe("buildAddTaskPayload", () => {
  it("sends title and instructions as separate fields", () => {
    const payload = buildAddTaskPayload({
      projectId: "p1",
      title: "GPU smoke",
      instructions: "Run nvidia-smi and report",
      agentId: "a1",
      environmentId: "env-1",
    });
    assert.deepEqual(payload, {
      type: "addTask",
      projectId: "p1",
      title: "GPU smoke",
      owner: "a1",
      instructions: "Run nvidia-smi and report",
      environmentId: "env-1",
    });
  });

  it("omits empty environmentId", () => {
    const payload = buildAddTaskPayload({
      projectId: "p1",
      title: "No env",
      instructions: "Do the work",
      agentId: "a1",
      environmentId: "  ",
    });
    assert.equal("environmentId" in payload, false);
  });

  it("binds a ready run box by its job id", () => {
    assert.deepEqual(buildAddTaskPayload({ projectId: "p1", title: "GPU", instructions: "Run it", agentId: "a1", runBoxId: "j1" }), {
      type: "addTask", projectId: "p1", title: "GPU", owner: "a1", instructions: "Run it", runBoxId: "j1",
    });
    assert.throws(() => buildAddTaskPayload({ projectId: "p1", title: "GPU", instructions: "Run it", agentId: "a1", runBoxId: "j1", environmentId: "e1" }));
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

  it("rejects oversized title or instructions", () => {
    assert.throws(() =>
      buildAddTaskPayload({
        projectId: "p1",
        title: "T".repeat(201),
        instructions: "ok",
        agentId: "a1",
      }),
    );
    assert.throws(() =>
      buildAddTaskPayload({
        projectId: "p1",
        title: "T",
        instructions: "x".repeat(4001),
        agentId: "a1",
      }),
    );
  });
});
