import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LoopbackApiClient,
  LoopbackApiError,
  joinApiUrl,
  mapApiFailure,
  normalizeBaseUrl,
  serverUnreachableMessage,
} from "../electron/api-client.ts";

describe("loopback URL helpers", () => {
  it("normalizes and joins paths", () => {
    assert.equal(normalizeBaseUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
    assert.equal(normalizeBaseUrl(""), "http://127.0.0.1:3000");
    assert.equal(
      joinApiUrl("http://127.0.0.1:3000/", "/api/state"),
      "http://127.0.0.1:3000/api/state",
    );
    assert.equal(
      joinApiUrl("http://127.0.0.1:3000", "api/state"),
      "http://127.0.0.1:3000/api/state",
    );
  });

  it("maps failures without leaking secrets", () => {
    const message = mapApiFailure(
      401,
      JSON.stringify({ error: "Employee sign-in required" }),
      "http://127.0.0.1:3000",
    );
    assert.match(message, /sign-in/i);
    assert.equal(message.includes("Bearer"), false);
    assert.equal(message.includes("cookie"), false);
    assert.match(
      serverUnreachableMessage("http://127.0.0.1:3000"),
      /Cannot reach AgentCloud/,
    );
  });
});

describe("LoopbackApiClient", () => {
  it("getState returns revision and projects", async () => {
    const client = new LoopbackApiClient({
      getBaseUrl: () => "http://127.0.0.1:3000",
      request: async () =>
        new Response(
          JSON.stringify({
            revision: 3,
            projects: [{ id: "p1", name: "Demo" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const state = await client.getState();
    assert.equal(state.revision, 3);
    assert.equal(state.projectCount, 1);
    assert.equal(state.projects[0]?.id, "p1");
    assert.equal(state.projects[0]?.name, "Demo");
    assert.deepEqual(state.projects[0]?.agents, []);
    assert.deepEqual(state.projects[0]?.resources, []);
  });

  it("surfaces actionable error when request throws", async () => {
    const client = new LoopbackApiClient({
      getBaseUrl: () => "http://127.0.0.1:3000",
      request: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(
      () => client.getState(),
      (error: unknown) =>
        error instanceof LoopbackApiError &&
        /Cannot reach AgentCloud at http:\/\/127\.0\.0\.1:3000/.test(
          error.message,
        ),
    );
  });

  it("postAction reads nested state", async () => {
    const client = new LoopbackApiClient({
      getBaseUrl: () => "http://127.0.0.1:3000",
      request: async (_path, init) => {
        assert.equal(init?.method, "POST");
        return new Response(
          JSON.stringify({
            id: "t1",
            state: { revision: 4, projects: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await client.postAction({
      type: "addTask",
      projectId: "p1",
      title: "Hello",
      owner: "a1",
    });
    assert.equal(result.state.revision, 4);
    assert.equal(result.state.projectCount, 0);
  });
});
