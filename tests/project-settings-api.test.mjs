import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-project-settings-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
for (const name of ["store", "http", "resource-profiles"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), transpile(source).replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
for (const name of ["run-box-jobs", "aws-organization-approval", "machine-catalog"])
  await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
const routeSource = await readFile(new URL("../app/api/projects/[id]/settings/route.ts", import.meta.url), "utf8");
await writeFile(path.join(directory, "settings-route.js"), transpile(routeSource)
  .replace(/from ["'](?:\.\.\/)+lib\/([\w-]+)\.mjs["']/g, "from './$1.mjs'")
  .replace(/from ["'](?:\.\.\/)+lib\/([\w-]+)["']/g, "from './$1.js'"));
const route = await import(path.join(directory, "settings-route.js"));
const store = await import(path.join(directory, "store.js"));
after(async () => {
  fixture.getDatabase().close();
  await rm(directory, { recursive: true, force: true });
});

const [owner, member] = fixture.users;
const url = (id) => `http://localhost:3000/api/projects/${id}/settings`;
const context = (id) => ({ params: Promise.resolve({ id }) });
const get = (id, cookie) => route.GET(new Request(url(id), { headers: cookie ? { cookie } : {} }), context(id));
const patch = (id, cookie, data, origin = "http://localhost:3000") => route.PATCH(new Request(url(id), {
  method: "PATCH",
  headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(data),
}), context(id));

const created = await store.action({ type: "createProject", name: "Settings test", repo: "https://example.com/team/repo", template: "blank", compute: "Hosted Linux" });
const projectId = created.id;
fixture.grantMembership(owner.id, projectId, "owner");

test("anonymous and non-member employees cannot read or change project settings", async () => {
  assert.equal((await get(projectId)).status, 401);
  assert.equal((await patch(projectId, null, { name: "Nope" })).status, 401);
  // The second fixture user belongs to the organization but has no project access.
  assert.equal((await get(projectId, member.cookie)).status, 403);
  assert.equal((await patch(projectId, member.cookie, { name: "Nope" })).status, 403);
  assert.equal((await store.getState()).projects[0].name, "Settings test");
});

test("members can read settings but only owners can change them", async () => {
  fixture.grantMembership(member.id, projectId, "member");
  try {
    const response = await get(projectId, member.cookie);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.permissions, { edit: false, invite: false });
    assert.deepEqual(data.invitations, []);
    assert.deepEqual(data.candidates, []);
    assert.deepEqual(data.project.environmentDefaults, { machineId: null, visibility: "private", sharedMemory: false });
    assert.deepEqual(data.members.map((item) => [item.email, item.role, item.implicit]).sort(), [
      [owner.email, "owner", true],
      [member.email, "member", false],
    ]);
    for (const change of [{ name: "Member rename" }, { environmentDefaults: { machineId: "aws-cpu", visibility: "public" } }])
      assert.equal((await patch(projectId, member.cookie, change)).status, 403);
    assert.equal((await store.getState()).projects[0].name, "Settings test");
  } finally {
    fixture.getDatabase().prepare("DELETE FROM project_membership WHERE user_id=? AND project_id=?").run(member.id, projectId);
  }
});

test("owners see invite controls and organization members who lack project access", async () => {
  const data = await (await get(projectId, owner.cookie)).json();
  assert.deepEqual(data.permissions, { edit: true, invite: true });
  assert.deepEqual(data.candidates.map((item) => item.email), [member.email]);
  assert.ok(data.machines.some((machine) => machine.id === "aws-cpu"));
  assert.equal(data.mailMode, "local");
});

test("owners update the name, repository, and environment defaults with validation", async () => {
  for (const change of [
    { name: "   " },
    { name: "x".repeat(101) },
    { name: "bad\u0007name" },
    { repo: "http://example.com/repo" },
    { repo: "https://user:secret@example.com/repo" },
    { repo: "not a url" },
    { environmentDefaults: { machineId: "p5.48xlarge", visibility: "private" } },
    { environmentDefaults: { machineId: "aws-cpu", visibility: "everyone" } },
    { environmentDefaults: "public" },
    { environmentDefaults: { machineId: "aws-cpu", visibility: "private", sharedMemory: "yes" } },
    {},
  ]) assert.equal((await patch(projectId, owner.cookie, change)).status, 400, JSON.stringify(change));
  assert.equal((await patch(projectId, owner.cookie, { name: "Cross" }, "https://evil.example")).status, 403);
  const response = await patch(projectId, owner.cookie, {
    name: "  Renamed project ",
    repo: "https://github.com/team/renamed",
    environmentDefaults: { machineId: "aws-gpu-t4", visibility: "public", sharedMemory: true },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).project, {
    id: projectId,
    name: "Renamed project",
    repo: "https://github.com/team/renamed",
    environmentDefaults: { machineId: "aws-gpu-t4", visibility: "public", sharedMemory: true },
  });
  const saved = (await store.getState()).projects[0];
  assert.equal(saved.name, "Renamed project");
  assert.equal(saved.events[0].text, "Updated project name, repository, environment defaults");
  // Omitting sharedMemory keeps the saved choice.
  const cleared = await patch(projectId, owner.cookie, { environmentDefaults: { machineId: null, visibility: "private" } });
  assert.deepEqual((await cleared.json()).project.environmentDefaults, { machineId: null, visibility: "private", sharedMemory: true });
});

test("project settings are not reachable through the member action endpoint", async () => {
  await assert.rejects(store.action({ type: "updateProject", projectId, name: "Bypass" }));
  assert.equal((await store.getState()).projects[0].name, "Renamed project");
});
