import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// HAC-166: staging worker install scripts.
const scripts = ["scripts/install-run-box-worker.sh", "scripts/aws-cpu-operator-key.sh",
  "scripts/aws-auth/remote-deploy.sh", "scripts/aws-auth/service-start.sh"];

test("staging install and deploy scripts are valid bash", () => {
  for (const script of scripts) execFileSync("bash", ["-n", script]);
});

test("the staging worker unit configures aws-cpu and the app trusts CloudFront's viewer header", () => {
  const install = readFileSync("scripts/install-run-box-worker.sh", "utf8");
  for (const line of ["Environment=AGENTCLOUD_AWS_CPU_SSH_CIDR=auto", "Environment=AGENTCLOUD_AWS_CPU_SSH_KEY_FILE=$CPU_KEY_DIR/id_ed25519",
    'Environment="AGENTCLOUD_AWS_CPU_SSH_PUBLIC_KEY=$CPU_PUBLIC_KEY"', "Environment=AGENTCLOUD_GPU_SUBNET_ID=$SUBNET",
    "Environment=AGENTCLOUD_DATA_DIR=$DATA", "User=agentcloud"])
    assert.ok(install.includes(line), line);
  const deploy = readFileSync("scripts/aws-auth/remote-deploy.sh", "utf8");
  assert.ok(deploy.includes("Environment=AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1"));
  // The app and the worker share the data directory, so Codex sessions use the runner key the worker installs.
  assert.match(readFileSync("scripts/aws-auth/service-start.sh", "utf8"), /AGENTCLOUD_DATA_DIR=\/var\/lib\/agentcloud/);
  assert.match(deploy, /install -m 0644 "\$RELEASE\/scripts\/aws-auth\/runtime-secret.mjs"/);
  assert.match(readFileSync("scripts/aws-auth/service-start.sh", "utf8"), /runtime-secret\.mjs/);
});

test("the hosted start script keeps a plain auth secret and reads Backboard from JSON", () => {
  const load = (secret) => {
    const assignments = execFileSync(process.execPath, ["scripts/aws-auth/runtime-secret.mjs"], { input: secret, encoding: "utf8" });
    // Read the values from a child process: service-start.sh execs npm/next, which only see exported variables.
    const child = execFileSync("bash", ["-c", 'eval "$1"; exec "$2" -e \'process.stdout.write(`${(process.env.BETTER_AUTH_SECRET || "").length}\\n${process.env.BACKBOARD_API_KEY || ""}`)\'', "runtime", assignments, process.execPath],
      { encoding: "utf8", env: { PATH: process.env.PATH } });
    const [authLength, board] = child.split("\n");
    return { authLength: Number(authLength), board };
  };
  const plain = "a".repeat(40);
  assert.deepEqual(load(plain), { authLength: 40, board: "" });
  const quoted = `${"b".repeat(31)}'`;
  assert.deepEqual(load(JSON.stringify({ BETTER_AUTH_SECRET: quoted, BACKBOARD_API_KEY: "espr_test_key" })), { authLength: 32, board: "espr_test_key" });
  assert.deepEqual(load(JSON.stringify({ BETTER_AUTH_SECRET: plain })), { authLength: 40, board: "" });
  assert.throws(() => load("short"), /Staging auth secret is not initialized/);
});

test("SMTP settings in the runtime secret reach the app and switch mail to SMTP", () => {
  const run = (secret) => {
    const assignments = execFileSync(process.execPath, ["scripts/aws-auth/runtime-secret.mjs"], { input: secret, encoding: "utf8" });
    // Mirror service-start.sh: eval the assignments, choose the mail mode, then read from a child process.
    const mode = readFileSync("scripts/aws-auth/service-start.sh", "utf8").match(/^if \[\[ -n "\$\{SMTP_HOST.*$/m)[0];
    return JSON.parse(execFileSync("bash", ["-c", `eval "$1"; ${mode}; exec "$2" -e 'const e = process.env; process.stdout.write(JSON.stringify({ mode: e.AGENTCLOUD_MAIL_MODE, host: e.SMTP_HOST || null, user: e.SMTP_USER || null, passwordLength: (e.SMTP_PASSWORD || "").length, from: e.SMTP_FROM || null }))'`,
      "runtime", assignments, process.execPath], { encoding: "utf8", env: { PATH: process.env.PATH } }));
  };
  const auth = "a".repeat(40);
  assert.deepEqual(run(auth), { mode: "local", host: null, user: null, passwordLength: 0, from: null });
  assert.deepEqual(run(JSON.stringify({ BETTER_AUTH_SECRET: auth, SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587",
    SMTP_USER: "me@example.com", SMTP_PASSWORD: "abcdefghijklmnop", SMTP_FROM: "alto <me@example.com>" })),
  { mode: "smtp", host: "smtp.gmail.com", user: "me@example.com", passwordLength: 16, from: "alto <me@example.com>" });
  assert.throws(() => run(JSON.stringify({ BETTER_AUTH_SECRET: auth, SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@example.com" })), /SMTP settings are incomplete/);
  assert.throws(() => run(JSON.stringify({ BETTER_AUTH_SECRET: auth, SMTP_HOST: "smtp.gmail.com\nX=1", SMTP_FROM: "a@b.c" })), /SMTP settings are invalid/);
});

test("the operator key is generated once, kept private, and only its public half is printed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentcloud-operator-key-"));
  try {
    const directory = path.join(root, "aws-cpu");
    const run = () => execFileSync("bash", ["scripts/aws-cpu-operator-key.sh", directory], { encoding: "utf8" });
    const first = run();
    assert.match(first, /^ssh-ed25519 [A-Za-z0-9+/]+=*\n$/);
    assert.doesNotMatch(first, /PRIVATE KEY/);
    const key = path.join(directory, "id_ed25519");
    const privateBefore = readFileSync(key, "utf8");
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(key).mode & 0o777, 0o600);
    assert.equal(statSync(`${key}.pub`).mode & 0o777, 0o600);
    assert.equal(execFileSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" }).split(" ").slice(0, 2).join(" "), first.trim());
    // Idempotent: a rerun keeps the key and restores a missing public half.
    rmSync(`${key}.pub`);
    assert.equal(run(), first);
    assert.equal(readFileSync(key, "utf8"), privateBefore);
    assert.match(readFileSync(`${key}.pub`, "utf8"), /^ssh-ed25519 \S+ agentcloud-aws-cpu-operator\n$/);
    assert.throws(() => execFileSync("bash", ["scripts/aws-cpu-operator-key.sh", "relative"], { stdio: "pipe" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
