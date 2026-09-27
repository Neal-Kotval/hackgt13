import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";
const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-auth-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
for (const name of ["store", "http", "resource-profiles"]) {
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
const routes = {};
for (const name of [
  "state",
  "resources",
  "events",
  "employee",
  "agent",
  "actions",
]) {
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
      /from ["']\.\.\/\.\.\/\.\.\/lib\/([\w-]+)["']/g,
      "from './$1.js'",
    )
    .replace("../../../lib/auth.mjs", "./auth.mjs")
    .replace("../state/route", "./state-route.js");
  await writeFile(path.join(directory, `${name}-route.js`), output);
  routes[name] = await import(path.join(directory, `${name}-route.js`));
}
const store = await import(path.join(directory, "store.js"));
const request = (route, body, cookie, extra = {}) =>
  new Request(`http://localhost:3000/api/${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
after(async () => {
  fixture.getDatabase().close();
  await rm(directory, { recursive: true, force: true });
});
test("all human mutations deny anonymous and agent credentials without persisting records", async () => {
  for (const route of ["state", "actions", "resources"]) {
    for (const headers of [
      {},
      { authorization: "Bearer agent-token" },
      { cookie: "better-auth.session_token=fabricated" },
    ]) {
      const response = await routes[route].POST(
        request(
          route,
          { type: "createProject", name: "Forbidden" },
          null,
          headers,
        ),
      );
      assert.equal(response.status, 401);
    }
  }
  assert.deepEqual(await store.getState(), { projects: [], revision: 0 });
  for (const route of ["state", "events", "employee"])
    assert.equal((await routes[route].GET(request(route))).status, 401);
});
test("membership and employee identity come from the server, never client IDs", async () => {
  const [first, second] = fixture.users;
  const response = await routes.state.POST(
    request(
      "state",
      {
        type: "createProject",
        name: "Auth test",
        repo: "https://example.com/repo",
        template: "blank",
        compute: "Hosted Linux",
        userId: second.id,
      },
      first.cookie,
    ),
  );
  assert.equal(response.status, 200);
  const project = await response.json();
  assert.equal(fixture.memberships(first.id)[0].role, "owner");
  assert.deepEqual(fixture.memberships(second.id), []);
  assert.equal(
    (await routes.state.GET(request("state", null, second.cookie))).status,
    200,
  );
  assert.deepEqual(
    (
      await (
        await routes.state.GET(request("state", null, second.cookie))
      ).json()
    ).projects,
    [],
  );
  const denied = await routes.state.POST(
    request(
      "state",
      {
        type: "addTask",
        projectId: project.id,
        title: "Impersonation",
        employeeId: first.id,
        userId: first.id,
        role: "owner",
      },
      second.cookie,
      { "x-user-id": first.id },
    ),
  );
  assert.equal(denied.status, 403);
  fixture.grantMembership(second.id, project.id, "member");
  const identity = await (
    await routes.employee.GET(
      request("employee", null, second.cookie, { "x-user-id": first.id }),
    )
  ).json();
  assert.equal(identity.id, second.id);
  assert.equal(identity.memberships[0].role, "member");
  const agent = await store.action({
    type: "addAgent",
    projectId: project.id,
    client: "Codex",
    role: "test",
  });
  assert.equal(
    (
      await routes.state.GET(
        request("state", null, null, {
          authorization: `Bearer ${agent.token}`,
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await routes.agent.POST(
        request("agent", { type: "context" }, first.cookie),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await routes.agent.POST(
        request("agent", { type: "context" }, null, {
          authorization: `Bearer ${agent.token}`,
        }),
      )
    ).status,
    200,
  );
});
test("project owners can rotate and revoke an agent token while members cannot", async () => {
  const [owner, member] = fixture.users;
  const created = await routes.state.POST(request("state", {
    type: "createProject", name: "Token lifecycle", repo: "https://example.com/repo", template: "blank", compute: "Hosted Linux",
  }, owner.cookie));
  assert.equal(created.status, 200);
  const projectId = (await created.json()).id;
  fixture.grantMembership(member.id, projectId, "member");
  const agent = await routes.state.POST(request("state", {
    type: "addAgent", projectId, client: "Codex", role: "test",
  }, owner.cookie));
  assert.equal(agent.status, 200);
  const { agentId, token: oldToken } = await agent.json();
  const context = (token) => routes.agent.POST(request("agent", { type: "context", projectId, agentId }, null, { authorization: `Bearer ${token}` }));
  assert.equal((await context(oldToken)).status, 200);

  for (const type of ["rotateAgentToken", "revokeAgentToken"]) {
    assert.equal((await routes.state.POST(request("state", { type, projectId, agentId }, member.cookie))).status, 403);
  }
  assert.equal((await context(oldToken)).status, 200);

  const rotated = await routes.state.POST(request("state", { type: "rotateAgentToken", projectId, agentId }, owner.cookie));
  assert.equal(rotated.status, 200);
  const { token: newToken } = await rotated.json();
  assert.ok(newToken);
  assert.notEqual(newToken, oldToken);
  assert.equal((await context(oldToken)).status, 401);
  assert.equal((await context(newToken)).status, 200);
  assert.ok(!JSON.stringify(await (await routes.state.GET(request("state", null, owner.cookie))).json()).includes(newToken));
  const saved = await readFile(path.join(process.env.AGENTCLOUD_DATA_DIR, "state.json"), "utf8");
  assert.ok(!saved.includes(oldToken) && !saved.includes(newToken));
  assert.equal(JSON.parse(saved).credentials.filter((c) => c.agentId === agentId).length, 1);

  const revoked = await routes.state.POST(request("state", { type: "revokeAgentToken", projectId, agentId }, owner.cookie));
  assert.equal(revoked.status, 200);
  assert.equal((await context(newToken)).status, 401);
  const restored = await routes.state.POST(request("state", { type: "rotateAgentToken", projectId, agentId }, owner.cookie));
  assert.equal(restored.status, 200);
  const restoredToken = (await restored.json()).token;
  assert.ok(restoredToken);
  assert.equal((await context(newToken)).status, 401);
  assert.equal((await context(restoredToken)).status, 200);
});
test("signup requires verification, wrong passwords fail, sessions survive a new process, logout revokes", async () => {
  const auth = fixture.getAuth();
  const signup = await auth.handler(
    request("auth/sign-up/email", {
      email: "public@example.test",
      name: "Public",
      password: randomBytes(24).toString("hex"),
    }),
  );
  assert.equal(signup.status, 200);
  const newUser = fixture.getDatabase().prepare("SELECT emailVerified FROM user WHERE email = ?").get("public@example.test");
  assert.equal(newUser.emailVerified, 0);
  const bad = await auth.handler(
    request("auth/sign-in/email", {
      email: fixture.users[0].email,
      password: "wrong-password",
    }),
  );
  assert.equal(bad.status, 401);
  for (const user of fixture.users) {
    const identity = await (
      await routes.employee.GET(request("employee", null, user.cookie))
    ).json();
    assert.equal(identity.id, user.id);
    const child = `import { getAuth } from ${JSON.stringify(path.join(directory, "auth.mjs"))}; const session = await getAuth().api.getSession({ headers: new Headers({cookie: process.env.TEST_COOKIE}) }); process.stdout.write(session.user.id);`;
    assert.equal(
      execFileSync(process.execPath, ["--input-type=module", "-e", child], {
        env: { ...process.env, TEST_COOKIE: user.cookie },
        encoding: "utf8",
      }),
      user.id,
    );
    const logout = await auth.handler(
      request("auth/sign-out", {}, user.cookie, {
        origin: "http://localhost:3000",
      }),
    );
    assert.equal(logout.status, 200);
    assert.equal(
      (await routes.employee.GET(request("employee", null, user.cookie)))
        .status,
      401,
    );
  }
});

test("documented migration and bootstrap are repeatable and preserve credentials", async () => {
  const environment = {
    ...process.env,
    AGENTCLOUD_EMPLOYEE1_EMAIL: fixture.users[0].email,
    AGENTCLOUD_EMPLOYEE2_EMAIL: fixture.users[1].email,
    AGENTCLOUD_EMPLOYEE1_PASSWORD: randomBytes(24).toString("base64url"),
    AGENTCLOUD_EMPLOYEE2_PASSWORD: randomBytes(24).toString("base64url"),
  };
  const before = fixture
    .getDatabase()
    .prepare("SELECT id, password FROM account ORDER BY id")
    .all();
  const projectId = (await store.getState()).projects[0].id;
  for (let count = 0; count < 2; count++) {
    execFileSync(process.execPath, ["scripts/auth-setup.mjs"], {
      env: environment,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/auth-bootstrap.mjs", projectId], {
      env: environment,
      stdio: "pipe",
    });
  }
  assert.deepEqual(
    fixture
      .getDatabase()
      .prepare("SELECT id, password FROM account ORDER BY id")
      .all(),
    before,
  );
  assert.equal(
    fixture.getDatabase().prepare("SELECT count(*) AS count FROM user").get()
      .count,
    3,
  );
  assert.equal(fixture.memberships(fixture.users[0].id)[0].role, "owner");
  assert.equal(fixture.memberships(fixture.users[1].id)[0].role, "member");
});

test("bootstrap creates two usable employees on an empty migrated database", async () => {
  const environment = {
    ...process.env,
    AGENTCLOUD_DATA_DIR: path.join(directory, "fresh-bootstrap"),
    AGENTCLOUD_EMPLOYEE1_EMAIL: "bootstrap-first@example.test",
    AGENTCLOUD_EMPLOYEE2_EMAIL: "bootstrap-second@example.test",
    AGENTCLOUD_EMPLOYEE1_PASSWORD: randomBytes(24).toString("base64url"),
    AGENTCLOUD_EMPLOYEE2_PASSWORD: randomBytes(24).toString("base64url"),
  };
  execFileSync(process.execPath, ["scripts/auth-setup.mjs"], {
    env: environment,
    stdio: "pipe",
  });
  execFileSync(process.execPath, ["scripts/auth-bootstrap.mjs"], {
    env: environment,
    stdio: "pipe",
  });
  const child = `import { getAuth, getDatabase } from ${JSON.stringify(path.join(directory, "auth.mjs"))};
    const fs = await import('node:fs/promises');
    const p = await import('node:path');
    const mailbox=p.join(process.env.AGENTCLOUD_DATA_DIR,'mail');
    for (const file of await fs.readdir(mailbox)) {
      const mail=JSON.parse(await fs.readFile(p.join(mailbox,file),'utf8'));
      await getAuth().handler(new Request(mail.text.match(/http[^\\s]+/)[0]));
    }
    const ids = [];
    for (const number of [1,2]) {
      const result = await getAuth().api.signInEmail({body: {email: process.env['AGENTCLOUD_EMPLOYEE'+number+'_EMAIL'], password: process.env['AGENTCLOUD_EMPLOYEE'+number+'_PASSWORD']}});
      ids.push(result.user.id);
    }
    if (ids[0] === ids[1]) throw Error('Identities must differ');
    if (getDatabase().prepare('SELECT count(*) AS count FROM project_membership').get().count !== 0) throw Error('Unexpected seeded membership');
    process.stdout.write('ok');`;
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", child], {
      env: environment,
      encoding: "utf8",
    }),
    "ok",
  );
});
