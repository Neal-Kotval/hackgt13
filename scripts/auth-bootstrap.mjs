import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
import { readFile } from "node:fs/promises";
import path from "node:path";
import { betterAuth } from "better-auth";
import { authOptions, getDatabase, grantMembership } from "../lib/auth.mjs";
loadEnvConfig(process.cwd());
const employees = [1, 2].map((number) => ({
  email: process.env[`AGENTCLOUD_EMPLOYEE${number}_EMAIL`]
    ?.trim()
    .toLowerCase(),
  password: process.env[`AGENTCLOUD_EMPLOYEE${number}_PASSWORD`],
  name: `Employee ${number}`,
}));
if (
  employees.some(
    (employee) =>
      !employee.email?.includes("@") ||
      !employee.password ||
      employee.password.length < 12,
  ) ||
  employees[0].email === employees[1].email
) {
  throw new Error(
    "Supply two distinct AGENTCLOUD_EMPLOYEE{1,2}_EMAIL values and PASSWORD values of at least 12 characters through the environment.",
  );
}
const projectId = process.argv[2];
if (projectId) {
  const state = JSON.parse(
    await readFile(
      path.join(process.env.AGENTCLOUD_DATA_DIR || ".agentcloud", "state.json"),
      "utf8",
    ),
  );
  if (!state.state.projects.some((project) => project.id === projectId))
    throw new Error("Unknown project ID");
}
// Optional local account setup. Accounts must still verify their email.
const options = authOptions();
const bootstrap = betterAuth({
  ...options,
  emailAndPassword: {
    ...options.emailAndPassword,
    disableSignUp: false,
    autoSignIn: false,
  },
});
for (const [index, employee] of employees.entries()) {
  let user = getDatabase()
    .prepare("SELECT id FROM user WHERE email = ?")
    .get(employee.email);
  if (!user) user = (await bootstrap.api.signUpEmail({ body: employee })).user;
  if (projectId)
    grantMembership(user.id, projectId, index === 0 ? "owner" : "member");
}
getDatabase().close();
console.log(
  "Two employee accounts exist. Verify their emails before signing in. Existing passwords were preserved." +
    (projectId
      ? " Project memberships assigned: owner and member."
      : " No projects were created. Pass an existing project ID to assign memberships."),
);
