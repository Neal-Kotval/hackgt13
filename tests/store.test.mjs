import { prepareAuth } from "./auth-fixture.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
const temporary = await mkdtemp(path.join(os.tmpdir(), "agentcloud-test-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(temporary, "data");
await writeFile(path.join(temporary, "package.json"), '{"type":"module"}');
for (const name of ["store", "http", "resource-profiles"]) {
  const source = await readFile(
    new URL(`../lib/${name}.ts`, import.meta.url),
    "utf8",
  );
  const output = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    })
    .outputText.replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'");
  await writeFile(path.join(temporary, `${name}.js`), output);
}
const { action, getState, agentAction } = await import(
  path.join(temporary, "store.js")
);
const authFixture = await prepareAuth(temporary);
after(() => rm(temporary, { recursive: true, force: true }));
test("fresh installation starts empty and remains stable without creating a data file", async () => {
  assert.deepEqual(await getState(), { projects: [], revision: 0 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await getState(), { projects: [], revision: 0 });
  await assert.rejects(readFile(path.join(temporary, "data", "state.json")), {
    code: "ENOENT",
  });
});
test("persistent collaboration, isolation, dependency enforcement, and serialized updates", async () => {
  const { id } = await action({
    type: "createProject",
    name: "Integration test",
    repo: "https://github.com/example/repo",
    template: "blank",
    compute: "SSH machine",
    host: "example.test",
  });
  const first = await action({
    type: "addAgent",
    projectId: id,
    client: "Codex",
    role: "backend",
  });
  const second = await action({
    type: "addAgent",
    projectId: id,
    client: "Claude",
    role: "frontend",
  });
  await agentAction(first.token, {
    type: "connect",
    projectId: id,
    agentId: first.agentId,
  });
  await assert.rejects(
    agentAction(first.token, { type: "context", projectId: "another-project" }),
    { status: 403 },
  );
  await assert.rejects(agentAction("invalid", { type: "context" }), {
    status: 401,
  });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      action({
        type: "addTask",
        projectId: id,
        title: `Task ${i}`,
        owner: first.agentId,
      }),
    ),
  );
  let p = (await getState()).projects.find((p) => p.id === id);
  assert.equal(p.tasks.length, 8);
  const task = p.tasks[0];
  await assert.rejects(
    agentAction(second.token, {
      type: "task",
      taskId: task.id,
      status: "done",
    }),
    { status: 403 },
  );
  await action({
    type: "addTask",
    projectId: id,
    title: "Dependent",
    owner: second.agentId,
    dependency: task.id,
  });
  p = (await getState()).projects.find((p) => p.id === id);
  const dependent = p.tasks.at(-1);
  await assert.rejects(
    agentAction(second.token, {
      type: "task",
      taskId: dependent.id,
      status: "in progress",
    }),
    { status: 409 },
  );
  await agentAction(first.token, {
    type: "task",
    taskId: task.id,
    status: "done",
  });
  await agentAction(second.token, {
    type: "task",
    taskId: dependent.id,
    status: "in progress",
  });
  await agentAction(first.token, {
    type: "service",
    name: "listings",
    url: "http://localhost:4000",
  });
  const context = await agentAction(second.token, { type: "context" });
  assert.equal(context.project.services[0].owner, first.agentId);
  await agentAction(first.token, {
    type: "handoff",
    to: second.agentId,
    title: "API ready",
    summary: "Use the endpoint",
    files: ["api.ts"],
    next: "Build UI",
  });
  const next = await agentAction(second.token, { type: "context" });
  assert.equal(next.project.handoffs[0].to, second.agentId);
  await assert.rejects(
    agentAction(first.token, { type: "shell", command: "whoami" }),
    { status: 403 },
  );
  await assert.rejects(
    agentAction(first.token, {
      type: "service",
      name: "bad",
      url: "javascript:alert(1)",
    }),
    { status: 400 },
  );
  const saved = await readFile(
    path.join(temporary, "data", "state.json"),
    "utf8",
  );
  assert.ok(!saved.includes(first.token));
  assert.ok(JSON.parse(saved).credentials[0].hash);
  assert.ok(!JSON.stringify(await getState()).includes("credentials"));
});
test("browser-facing Host permits same-origin mutations when Next rewrites the request URL", async () => {
  const { sameOrigin } = await import(path.join(temporary, "http.js"));
  const request = (origin, extra = {}) =>
    new Request("http://localhost:3000/api/state", {
      method: "POST",
      headers: { origin, host: "127.0.0.1:3000", ...extra },
    });
  assert.doesNotThrow(() => sameOrigin(request("http://127.0.0.1:3000")));
  assert.doesNotThrow(() =>
    sameOrigin(
      request("https://127.0.0.1:3000", { "x-forwarded-proto": "https" }),
    ),
  );
  for (const origin of [
    "http://evil.example",
    "http://127.0.0.1:3001",
    "https://127.0.0.1:3000",
    "not-a-url",
  ])
    assert.throws(() => sameOrigin(request(origin)), { status: 403 });
  assert.doesNotThrow(() =>
    sameOrigin(
      new Request("http://localhost:3000/api/state", {
        headers: { origin: "http://localhost:3000" },
      }),
    ),
  );
});
test("configured HTTPS app origin permits CloudFront proxied mutations", async () => {
  const { sameOrigin } = await import(path.join(temporary, "http.js"));
  const before = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://demo.cloudfront.net";
  try {
    const request = (origin) => new Request("http://localhost:3000/api/state", {
      method: "POST",
      headers: { origin, host: "demo.cloudfront.net", "x-forwarded-proto": "http" },
    });
    assert.doesNotThrow(() => sameOrigin(request("https://demo.cloudfront.net")));
    assert.throws(() => sameOrigin(request("http://demo.cloudfront.net")), { status: 403 });
    assert.throws(() => sameOrigin(request("https://evil.example")), { status: 403 });
  } finally {
    if (before === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = before;
  }
});
test("cross-origin browser mutations and malformed bodies are rejected", async () => {
  const { sameOrigin, body } = await import(path.join(temporary, "http.js"));
  assert.throws(
    () =>
      sameOrigin(
        new Request("http://localhost:3000/api/state", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    { status: 403 },
  );
  await assert.rejects(
    body(new Request("http://localhost", { method: "POST", body: "[]" })),
    { status: 400 },
  );
  await assert.rejects(
    body(
      new Request("http://localhost", {
        method: "POST",
        body: "x".repeat(32769),
      }),
    ),
    { status: 413 },
  );
});
test("HTTP route contract returns state and enforces bearer identity", async () => {
  for (const name of ["state", "agent"]) {
    const source = await readFile(
      new URL(`../app/api/${name}/route.ts`, import.meta.url),
      "utf8",
    );
    const output = ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      })
      .outputText.replace(
        /from ["']\.\.\/\.\.\/\.\.\/lib\/(\w+)["']/g,
        "from './$1.js'",
      ).replace("../../../lib/auth.mjs", "./auth.mjs");
    await writeFile(path.join(temporary, `${name}-route.js`), output);
  }
  const stateRoute = await import(path.join(temporary, "state-route.js"));
  const agentRoute = await import(path.join(temporary, "agent-route.js"));
  const projectId = (await getState()).projects[0].id;
  authFixture.grantMembership(authFixture.users[0].id, projectId, "owner");
  const response = await stateRoute.GET(new Request("http://localhost/api/state", { headers: { cookie: authFixture.users[0].cookie } }));
  assert.equal(response.status, 200);
  assert.ok((await response.json()).projects.length);
  const forbidden = await stateRoute.POST(
    new Request("http://localhost/api/state", {
      method: "POST",
      headers: { origin: "https://other.example", cookie: authFixture.users[0].cookie },
      body: JSON.stringify({ type: "addTask", projectId }),
    }),
  );
  assert.equal(forbidden.status, 403);
  const noToken = await agentRoute.POST(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: '{"type":"context"}',
    }),
  );
  assert.equal(noToken.status, 401);
  const created = await stateRoute.POST(
    new Request("http://localhost/api/state", {
      method: "POST",
      headers: { cookie: authFixture.users[0].cookie },
      body: JSON.stringify({
        type: "addAgent",
        projectId,
        client: "Test",
        role: "review",
      }),
    }),
  );
  const identity = await created.json();
  assert.ok(identity.state);
  assert.ok(identity.token);
  const connected = await agentRoute.POST(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${identity.token}` },
      body: JSON.stringify({
        type: "connect",
        projectId,
        agentId: identity.agentId,
      }),
    }),
  );
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).agentId, identity.agentId);
});
test("handoff acceptance assigns exactly one recipient follow-up and reuses matching active work", async () => {
  const p = (await getState()).projects[0];
  const h = p.handoffs[0];
  const before = p.tasks.length;
  const accepted = await action({
    type: "acceptHandoff",
    projectId: p.id,
    handoffId: h.id,
  });
  let updated = accepted.state.projects.find((project) => project.id === p.id);
  const followup = updated.tasks.find((t) => t.id === accepted.taskId);
  assert.equal(followup.owner, h.to);
  assert.equal(followup.title, h.next);
  assert.equal(followup.status, "queued");
  assert.equal(updated.tasks.length, before + 1);
  const repeated = await action({
    type: "acceptHandoff",
    projectId: p.id,
    handoffId: h.id,
  });
  assert.equal(repeated.taskId, accepted.taskId);
  assert.equal(
    repeated.state.projects.find((project) => project.id === p.id).tasks.length,
    before + 1,
  );
  const identity = await action({
    type: "addAgent",
    projectId: p.id,
    client: "Reviewer",
    role: "review",
  });
  await action({
    type: "addTask",
    projectId: p.id,
    title: "Review integration",
    owner: identity.agentId,
  });
  const handoff = await agentAction(identity.token, {
    type: "handoff",
    to: identity.agentId,
    title: "Review integration",
    summary: "Check the integration",
    files: [],
    next: "Run the integration checks",
  });
  const count = (await getState()).projects.find(
    (project) => project.id === p.id,
  ).tasks.length;
  const reused = await action({
    type: "acceptHandoff",
    projectId: p.id,
    handoffId: handoff.handoff.id,
  });
  updated = reused.state.projects.find((project) => project.id === p.id);
  assert.equal(updated.tasks.length, count);
  assert.equal(
    updated.tasks.find((t) => t.id === reused.taskId).title,
    "Review integration",
  );
});
test("project input rejects invalid repo, compute, and missing SSH host", async () => {
  const valid = {
    type: "createProject",
    name: "Validation",
    repo: "https://github.com/team/repo",
    template: "Empty workspace",
    compute: "Hosted Linux",
  };
  for (const override of [
    { repo: "http://github.com/team/repo" },
    { repo: "garbage" },
    { repo: "https://user:secret@github.com/repo" },
    { compute: "anything" },
    { compute: "SSH machine" },
    { compute: "SSH machine", host: "user@host; rm -rf /" },
  ])
    await assert.rejects(action({ ...valid, ...override }), { status: 400 });
  const result = await action({
    ...valid,
    compute: "SSH machine",
    host: "dev@my-server.local",
  });
  assert.ok(result.id);
});
test("stale heartbeat becomes disconnected in public state and SSE without a mutation", async () => {
  const p = (await getState()).projects[0];
  const identity = await action({
    type: "addAgent",
    projectId: p.id,
    client: "Heartbeat",
    role: "tester",
  });
  await agentAction(identity.token, { type: "connect" });
  const source = await readFile(
    new URL("../app/api/events/route.ts", import.meta.url),
    "utf8",
  );
  const output = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    })
    .outputText.replace(
      /from ["']\.\.\/\.\.\/\.\.\/lib\/(\w+)["']/g,
      "from './$1.js'",
    );
  await writeFile(path.join(temporary, "events-route.js"), output);
  const { GET } = await import(path.join(temporary, "events-route.js"));
  authFixture.grantMembership(authFixture.users[0].id, p.id, "owner");
  const stream = await GET(new Request("http://localhost/api/events", { headers: { cookie: authFixture.users[0].cookie } }));
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const decode = (chunk) =>
    JSON.parse(decoder.decode(chunk.value).slice(6).trim());
  const originalNow = Date.now;
  try {
    const first = decode(await reader.read());
    assert.equal(
      first.projects
        .find((project) => project.id === p.id)
        .agents.find((a) => a.id === identity.agentId).status,
      "connected",
    );
    const future = originalNow() + 46000;
    Date.now = () => future;
    const second = decode(await reader.read());
    assert.equal(second.revision, first.revision);
    assert.equal(
      second.projects
        .find((project) => project.id === p.id)
        .agents.find((a) => a.id === identity.agentId).status,
      "disconnected",
    );
    assert.equal(
      (await getState()).projects
        .find((project) => project.id === p.id)
        .agents.find((a) => a.id === identity.agentId).status,
      "disconnected",
    );
  } finally {
    Date.now = originalNow;
    await reader.cancel();
  }
});

test("addTask persists instructions and verified environmentId", async () => {
  const created = await action({
    type: "createProject",
    name: "Task fields",
    repo: "https://github.com/example/task-fields",
    template: "blank",
    compute: "Hosted Linux",
  });
  const projectId = created.id;
  const agent = await action({
    type: "addAgent",
    projectId,
    client: "Codex",
    role: "backend",
  });
  const diskPath = path.join(temporary, "data", "state.json");
  const disk = JSON.parse(await readFile(diskPath, "utf8"));
  const verifiedId = "11111111-1111-4111-8111-111111111111";
  const registeredId = "22222222-2222-4222-8222-222222222222";
  const now = new Date().toISOString();
  const project = disk.state.projects.find((row) => row.id === projectId);
  project.resources.push(
    {
      id: verifiedId,
      name: "Verified box",
      kind: "run-box",
      capability: "ssh",
      owner: "admin",
      status: "verified",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: registeredId,
      name: "Registered only",
      kind: "run-box",
      capability: "ssh",
      owner: "admin",
      status: "registered",
      createdAt: now,
      updatedAt: now,
    },
  );
  await writeFile(diskPath, JSON.stringify(disk));

  await assert.rejects(
    action({
      type: "addTask",
      projectId,
      title: "Bad env",
      owner: agent.agentId,
      environmentId: "missing-env",
    }),
    { status: 404 },
  );
  await assert.rejects(
    action({
      type: "addTask",
      projectId,
      title: "Unverified env",
      owner: agent.agentId,
      environmentId: registeredId,
    }),
    (error) =>
      error.status === 400 &&
      /verified/i.test(error.message),
  );

  await action({
    type: "addTask",
    projectId,
    title: "Smoke",
    owner: agent.agentId,
    instructions: "Run nvidia-smi and paste output",
    environmentId: verifiedId,
  });
  const task = (await getState()).projects
    .find((row) => row.id === projectId)
    .tasks.at(-1);
  assert.equal(task.title, "Smoke");
  assert.equal(task.instructions, "Run nvidia-smi and paste output");
  assert.equal(task.environmentId, verifiedId);
});
