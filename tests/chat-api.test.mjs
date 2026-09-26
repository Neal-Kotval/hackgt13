import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-chat-api-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
delete process.env.OPENAI_API_KEY;
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');

for (const name of ["store", "http", "resource-profiles", "project-chat"]) {
  const source = await readFile(
    new URL(`../lib/${name}.ts`, import.meta.url),
    "utf8",
  );
  await writeFile(
    path.join(directory, `${name}.js`),
    ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      })
      .outputText.replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"),
  );
}

const fixture = await prepareAuth(directory);
const store = await import(path.join(directory, "store.js"));

const chatSource = await readFile(
  new URL("../app/api/chat/route.ts", import.meta.url),
  "utf8",
);
await writeFile(
  path.join(directory, "chat-route.js"),
  ts
    .transpileModule(chatSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    })
    .outputText.replace(
      /from ["']\.\.\/\.\.\/\.\.\/lib\/([\w-]+)["']/g,
      "from './$1.js'",
    )
    .replace("from './auth.js'", "from './auth.mjs'"),
);
const chat = await import(path.join(directory, "chat-route.js"));

const owner = fixture.users[0];
const member = fixture.users[1];
const projectId = (
  await store.action({
    type: "createProject",
    name: "Chat project",
    repo: "https://example.com/repo",
    compute: "Hosted Linux",
    template: "blank",
  })
).id;
fixture.grantMembership(owner.id, projectId, "owner");
fixture.grantMembership(member.id, projectId, "member");

function request(body, cookie, extra = {}) {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

after(async () => {
  fixture.getDatabase().close();
  await rm(directory, { recursive: true, force: true });
});

test("POST /api/chat denies anonymous and cross-project callers", async () => {
  const body = {
    projectId,
    messages: [{ role: "user", content: "hello" }],
  };
  assert.equal((await chat.POST(request(body))).status, 401);
  assert.equal(
    (await chat.POST(request({ ...body, projectId: "missing" }, owner.cookie)))
      .status,
    403,
  );
});

test("POST /api/chat returns 503 when server model key is missing", async () => {
  delete process.env.OPENAI_API_KEY;
  const response = await chat.POST(
    request(
      {
        projectId,
        messages: [{ role: "user", content: "hello from desktop" }],
      },
      owner.cookie,
    ),
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.match(payload.error, /OPENAI_API_KEY/);
  assert.doesNotMatch(JSON.stringify(payload), /sk-/);
});

test("ensureProjectChatAgent provisions desktop-chat without exposing a token", async () => {
  const first = await store.ensureProjectChatAgent(projectId);
  assert.equal(first.name, "desktop-chat");
  assert.equal(first.created, true);
  assert.equal("token" in first, false);
  const again = await store.ensureProjectChatAgent(projectId);
  assert.equal(again.agentId, first.agentId);
  assert.equal(again.created, false);
  const state = await store.getState();
  const project = state.projects.find((row) => row.id === projectId);
  assert.ok(project.agents.some((agent) => agent.id === first.agentId));
});
