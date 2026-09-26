import { randomBytes } from "node:crypto";
import { copyFile, readFile, writeFile, symlink, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
export async function prepareAuth(directory) {
  process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.AGENTCLOUD_MAIL_MODE = "local";
  await symlink(
    path.resolve("node_modules"),
    path.join(directory, "node_modules"),
  );
  await copyFile(
    new URL("../lib/auth.mjs", import.meta.url),
    path.join(directory, "auth.mjs"),
  );
  await copyFile(new URL("../lib/mail.mjs", import.meta.url), path.join(directory, "mail.mjs"));
  const auth = await import(path.join(directory, "auth.mjs"));
  await (await getMigrations(auth.authOptions())).runMigrations();
  auth.migrateMemberships();
  const source = await readFile(
    new URL("../lib/employee.ts", import.meta.url),
    "utf8",
  );
  await writeFile(
    path.join(directory, "employee.js"),
    ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      })
      .outputText.replace(/from ["']\.\/(\w+)["']/g, "from './$1.js'"),
  );
  const password = randomBytes(24).toString("base64url");
  const options = auth.authOptions();
  const bootstrap = betterAuth({
    ...options,
    emailAndPassword: {
      ...options.emailAndPassword,
      disableSignUp: false,
      autoSignIn: false,
    },
  });
  const users = [];
  for (const email of ["first@example.test", "second@example.test"]) {
    const { user } = await bootstrap.api.signUpEmail({
      body: { email, password, name: email },
    });
    const mailDirectory = path.join(process.env.AGENTCLOUD_DATA_DIR, "mail");
    for (const file of await readdir(mailDirectory)) {
      const message = JSON.parse(await readFile(path.join(mailDirectory, file), "utf8"));
      if (message.to === email) {
        const link = message.text.match(/http[^\s]+/)[0];
        await auth.getAuth().handler(new Request(link));
      }
    }
    user.emailVerified = true;
    const response = await auth
      .getAuth()
      .handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ email, password }),
        }),
      );
    if (!response.ok) throw new Error("Fixture sign-in failed");
    users.push({
      ...user,
      cookie: response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
    });
  }
  const organization = await auth.getAuth().api.createOrganization({ body: { name: "Test organization", slug: "test-organization", userId: users[0].id } });
  auth.getDatabase().prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)').run(randomBytes(16).toString("hex"), organization.id, users[1].id, "member", Date.now());
  auth.getDatabase().prepare('UPDATE session SET activeOrganizationId=?').run(organization.id);
  return { ...auth, users, password, organization,
    grantMembership(userId, projectId, role) {
      if (!auth.getDatabase().prepare('SELECT 1 FROM project_organization WHERE project_id=?').get(projectId)) auth.attachProject(projectId, organization.id);
      auth.grantMembership(userId, projectId, role);
    },
  };
}
