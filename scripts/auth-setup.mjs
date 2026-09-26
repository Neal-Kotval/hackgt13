import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
if (!process.env.BETTER_AUTH_SECRET) {
  appendFileSync(
    ".env.local",
    `\nBETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}\n`,
    { mode: 0o600 },
  );
  chmodSync(".env.local", 0o600);
  // Re-read without printing the generated value.
  process.loadEnvFile(".env.local");
}
const { getMigrations } = await import("better-auth/db/migration");
const { authOptions, migrateMemberships, getDatabase } =
  await import("../lib/auth.mjs");
await (await getMigrations(authOptions())).runMigrations();
migrateMemberships();
getDatabase().close();
console.log(
  "SQLite authentication and organization schema is ready. Create an account at /sign-up.",
);
