import { prepareAuth } from "./auth-fixture.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const temporary = await mkdtemp(
  path.join(os.tmpdir(), "agentcloud-resources-"),
);
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
await copyFile(new URL("../lib/machine-catalog.mjs", import.meta.url), path.join(temporary, "machine-catalog.mjs"));
const { action, resourceAction: rawResourceAction, getState } = await import(path.join(temporary, "store.js"));
const authFixture = await prepareAuth(temporary);
const testActor = {
  employeeId: authFixture.users[0].id,
  organizationId: authFixture.organization.id,
  projectRole: "owner",
};
const resourceAction = (input) => rawResourceAction(input, testActor);
after(() => rm(temporary, { recursive: true, force: true }));

test("resource records persist without implying allocation or policy approval", async () => {
  const created = await action({
    type: "createProject",
    name: "Resource test",
    repo: "https://example.com/repo",
    template: "blank",
    compute: "Hosted Linux",
  });
  const projectId = created.id;
  assert.deepEqual(created.state.projects[0].resources, []);
  assert.deepEqual(created.state.projects[0].resourceRequests, []);
  const registered = await resourceAction({
    type: "registerResource",
    projectId,
    name: "Known GPU host",
    kind: "gpu",
    capability: "GPU capacity reported by administrator",
    owner: "Local administrator",
  });
  assert.equal(registered.resource.status, "registered");
  assert.ok(registered.resource.createdAt);
  const requested = await resourceAction({
    type: "requestResource",
    projectId,
    resourceId: registered.resource.id,
    purpose: "Run a GPU workload",
  });
  assert.equal(requested.request.kind, "gpu");
  assert.equal(requested.request.status, "requested");
  assert.deepEqual(requested.request.requestedBy, {
    employeeId: testActor.employeeId,
    organizationId: testActor.organizationId,
    projectRoleAtRequest: "owner",
  });
  assert.deepEqual(requested.request.decision, {
    status: "not_evaluated",
    reason: "Resource policy is not configured.",
  });
  const draft = await resourceAction({
    type: "saveInferenceDraft",
    projectId,
    name: "Model endpoint",
    owner: "Local administrator",
    capability: "Text generation",
    inference: {
      model: "example/model",
      hardware: "GPU requested",
      accessScope: "project",
      lifetime: "1 hour requested",
    },
  });
  assert.equal(draft.resource.kind, "inference-api");
  assert.equal(draft.resource.status, "draft");
  const disk = JSON.parse(
    await readFile(path.join(temporary, "data", "state.json"), "utf8"),
  );
  assert.equal(disk.state.projects[0].resources.length, 2);
  assert.equal(disk.state.projects[0].resourceRequests.length, 1);
  assert.deepEqual(
    (await getState()).projects[0].resourceRequests[0],
    requested.request,
  );
});

test("resource API rejects fabricated states, mismatched references, and oversized values", async () => {
  const p = (await getState()).projects[0];
  const existing = p.resources[0];
  const before = (await getState()).revision;
  for (const payload of [
    {
      type: "registerResource",
      projectId: p.id,
      name: "X",
      kind: "gpu",
      capability: "x",
      owner: "y",
      status: "verified",
    },
    {
      type: "requestResource",
      projectId: p.id,
      kind: "gpu",
      purpose: "x",
      status: "approved",
    },
    {
      type: "requestResource",
      projectId: p.id,
      kind: "gpu",
      purpose: "x",
      decision: { status: "approved" },
    },
    {
      type: "requestResource",
      projectId: p.id,
      resourceId: existing.id,
      kind: "run-box",
      purpose: "x",
    },
    {
      type: "requestResource",
      projectId: p.id,
      resourceId: "missing",
      kind: "gpu",
      purpose: "x",
    },
    {
      type: "requestResource",
      projectId: p.id,
      kind: "gpu",
      taskId: "missing",
      purpose: "x",
    },
    {
      type: "requestResource",
      projectId: p.id,
      kind: "gpu",
      gpuProfileId: "g6-l4-small",
      durationHours: 24,
      purpose: "x",
    },
    {
      type: "requestResource",
      projectId: p.id,
      kind: "gpu",
      gpuProfileId: "forged",
      durationHours: 1,
      purpose: "x",
    },
    {
      type: "requestResource",
      projectId: p.id,
      kind: "gpu",
      gpuProfileId: "g6-l4-small",
      durationHours: 1,
      estimatedComputeUsd: 0,
      purpose: "x",
    },
    {
      type: "registerResource",
      projectId: p.id,
      name: "X",
      kind: "inference-api",
      capability: "x",
      owner: "y",
    },
    {
      type: "saveInferenceDraft",
      projectId: p.id,
      name: "X",
      capability: "x",
      owner: "y",
      inference: {
        model: "m",
        hardware: "h",
        accessScope: "a",
        lifetime: "l",
        status: "running",
      },
    },
    {
      type: "registerResource",
      projectId: p.id,
      name: "x".repeat(101),
      kind: "gpu",
      capability: "x",
      owner: "y",
    },
  ])
    await assert.rejects(resourceAction(payload));
  assert.equal((await getState()).revision, before);
});

test("GPU request stores a bounded quote without authorizing a launch", async () => {
  const p = (await getState()).projects[0];
  const result = await resourceAction({
    type: "requestResource",
    projectId: p.id,
    kind: "gpu",
    gpuProfileId: "g6-l4-small",
    durationHours: 2,
    purpose: "Compare CPU and CUDA matrix computation",
  });
  assert.equal(result.request.computePreference.estimatedComputeUsd, 1.6096);
  assert.equal(result.request.computePreference.instanceType, "g6.xlarge");
  assert.equal(result.request.status, "requested");
  assert.equal(result.request.decision.status, "not_evaluated");
});

test("Runpod request pins GPU profile and ceiling without inventing a price", async () => {
  const p = await action({ type: "createProject", name: "Runpod profile test",
    repo: "https://example.com/runpod", template: "blank", compute: "Hosted Linux" });
  const result = await resourceAction({
    type: "requestResource", projectId: p.id, kind: "gpu",
    gpuProfileId: "runpod-rtx-4090", durationHours: 1,
    purpose: "Run a CUDA matrix smoke workload",
  });
  assert.deepEqual(result.request.computePreference, {
    provider: "runpod", profileId: "runpod-rtx-4090",
    gpuId: "NVIDIA GeForce RTX 4090", cloud: "SECURE",
    durationHours: 1, maxHourlyUsd: 1,
  });
  assert.equal(result.request.status, "requested");
  assert.equal(result.request.decision.status, "not_evaluated");
});

test("older project snapshots gain empty resource arrays without changing existing records", async () => {
  const file = path.join(temporary, "data", "state.json");
  const disk = JSON.parse(await readFile(file, "utf8"));
  const older = structuredClone(disk.state.projects[0]);
  delete older.resources;
  delete older.resourceRequests;
  disk.state.projects.push({ ...older, id: "legacy-project" });
  await writeFile(file, JSON.stringify(disk));
  const loaded = (await getState()).projects.find(
    (project) => project.id === "legacy-project",
  );
  assert.deepEqual(loaded.resources, []);
  assert.deepEqual(loaded.resourceRequests, []);
  assert.equal(loaded.name, older.name);
});

test("resource route returns persisted records and denies cross-origin mutations", async () => {
  const source = await readFile(
    new URL("../app/api/resources/route.ts", import.meta.url),
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
  await writeFile(path.join(temporary, "resources-route.js"), output);
  const { POST } = await import(path.join(temporary, "resources-route.js"));
  const projectId = (await getState()).projects[0].id;
  authFixture.grantMembership(authFixture.users[0].id, projectId, "owner");
  const payload = JSON.stringify({ type: "requestResource", projectId, kind: "run-box", purpose: "Use remote compute" });
  const unsigned = await POST(new Request("http://localhost/api/resources", {
    method: "POST", body: payload,
  }));
  assert.equal(unsigned.status, 401);
  const blocked = await POST(new Request("http://localhost/api/resources", {
    method: "POST", headers: { origin: "https://elsewhere.example", cookie: authFixture.users[0].cookie }, body: payload,
  }));
  assert.equal(blocked.status, 403);
  const accepted = await POST(new Request("http://localhost/api/resources", { method: "POST", headers: { cookie: authFixture.users[0].cookie }, body: payload }));
  assert.equal(accepted.status, 200);
  const response = await accepted.json();
  assert.equal(response.request.status, "requested");
  assert.deepEqual(response.request.requestedBy, {
    employeeId: authFixture.users[0].id,
    organizationId: authFixture.organization.id,
    projectRoleAtRequest: "owner",
  });
  const forged = await POST(new Request("http://localhost/api/resources", {
    method: "POST",
    headers: { cookie: authFixture.users[0].cookie },
    body: JSON.stringify({
      type: "requestResource", projectId, kind: "gpu", purpose: "Forge identity",
      requestedBy: { employeeId: authFixture.users[1].id },
    }),
  }));
  assert.equal(forged.status, 400);
  authFixture.grantMembership(authFixture.users[1].id, projectId, "member");
  const memberRequest = await POST(new Request("http://localhost/api/resources", {
    method: "POST",
    headers: { cookie: authFixture.users[1].cookie },
    body: JSON.stringify({
      type: "requestResource", projectId, kind: "gpu", purpose: "Request a GPU",
      gpuProfileId: "g6-l4-small", durationHours: 1,
    }),
  }));
  assert.equal(memberRequest.status, 200);
  const memberRecord = (await memberRequest.json()).request;
  assert.deepEqual(memberRecord.requestedBy, {
    employeeId: authFixture.users[1].id,
    organizationId: authFixture.organization.id,
    projectRoleAtRequest: "member",
  });
  assert.equal(memberRecord.decision.status, "not_evaluated");
  assert.equal(
    response.state.projects.find((p) => p.id === projectId).resourceRequests
      .length,
    3,
  );
});
