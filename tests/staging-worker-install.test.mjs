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
