import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePublicKey } from "./ssh-keys.mjs";

// Local Docker sandbox provider (HAC-88). Uses the docker CLI without a shell.
// Containers are CPU-only, unprivileged, resource-limited, and publish sshd on
// a random loopback port. Secret key material is passed through the docker
// CLI's environment (`-e NAME` without a value), never on the command line.

export const SANDBOX_IMAGE = "agentcloud-sandbox:dev";
export const SANDBOX_CONTEXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../infra/sandbox");
export const MANAGED_LABEL = "agentcloud.managed=docker-local";
const JOB_LABEL = "agentcloud.job";
const CONTEXT_LABEL = "agentcloud.sandbox.context";

// Content hash of the build context. ensureImage rebuilds when an existing
// image was built from different files (e.g. before Codex was added, HAC-121),
// so an old local image cannot silently lack the pinned toolchain.
export function sandboxContextHash(context = SANDBOX_CONTEXT) {
  const hash = createHash("sha256");
  for (const name of readdirSync(context).sort()) {
    hash.update(`${name}\0`);
    hash.update(readFileSync(path.join(context, name)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
const INSTALL_LABEL = "agentcloud.install";

// Several installs (worktrees, tests) can share one Docker host. Each worker
// only sees and reconciles containers labelled with its own data directory.
export function sandboxInstallId(dataDir = process.env.AGENTCLOUD_DATA_DIR || ".agentcloud") {
  return createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
}
const JOB_ID = /^[a-f0-9-]{36}$/;
// sshd privilege separation needs these; everything else is dropped.
const CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "SYS_CHROOT", "KILL", "AUDIT_WRITE", "NET_BIND_SERVICE"];

export function sandboxContainerName(jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new Error("Invalid sandbox job ID");
  return `agentcloud-sandbox-${jobId}`;
}

function defaultDocker(args, { env, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", args, { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Bounded stderr only; arguments never contain secrets but stay out of logs anyway.
          const detail = String(stderr || error.message).trim().split("\n").find((line) => line.trim())?.slice(0, 200) || "unknown error";
          const failure = new Error(`docker ${args[0]} failed: ${detail}`);
          failure.stderr = String(stderr || "");
          return reject(failure);
        }
        resolve(String(stdout));
      });
    if (input !== undefined) child.stdin.end(input);
  });
}

function parseRows(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [id, name, jobId, state] = line.split("\t");
    return { id, name, jobId: jobId || null, state };
  });
}

export function createDockerSandboxProvider({ docker = defaultDocker, image = SANDBOX_IMAGE,
  context = SANDBOX_CONTEXT, memory = "2g", cpus = "2", pidsLimit = 256, installId = sandboxInstallId() } = {}) {
  if (!/^[a-f0-9]{16}$/.test(installId)) throw new Error("Invalid sandbox install ID");
  const installLabel = `${INSTALL_LABEL}=${installId}`;
  const format = `{{.ID}}\t{{.Names}}\t{{.Label "${JOB_LABEL}"}}\t{{.State}}`;

  async function find(jobId) {
    sandboxContainerName(jobId);
    const rows = parseRows(await docker(["ps", "--all", "--no-trunc", "--filter", `label=${JOB_LABEL}=${jobId}`,
      "--filter", `label=${MANAGED_LABEL}`, "--filter", `label=${installLabel}`, "--format", format]));
    if (rows.length > 1) throw new Error("Duplicate sandbox containers for one job require reconciliation");
    return rows[0] || null;
  }

  return {
    async ensureImage() {
      const contextHash = sandboxContextHash(context);
      try {
        const label = (await docker(["image", "inspect", "--format", `{{index .Config.Labels "${CONTEXT_LABEL}"}}`, image])).trim();
        if (label === contextHash) return { built: false };
      } catch { /* Build below. */ }
      await docker(["build", "--quiet", "--label", `${CONTEXT_LABEL}=${contextHash}`, "--tag", image, context],
        { timeoutMs: 15 * 60_000 });
      return { built: true };
    },

    find,

    async create({ jobId, hostPrivateKeyB64, authorizedKeys, imageId = null }) {
      const name = sandboxContainerName(jobId);
      if (typeof hostPrivateKeyB64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(hostPrivateKeyB64))
        throw new Error("Invalid sandbox host key");
      if (!Array.isArray(authorizedKeys) || !authorizedKeys.length ||
          authorizedKeys.some((key) => typeof key !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(key)))
        throw new Error("Invalid sandbox authorized keys");
      if (imageId !== null && !/^sha256:[a-f0-9]{64}$/.test(imageId))
        throw new Error("Invalid sandbox image ID");
      const existing = await find(jobId);
      if (existing) return { containerId: existing.id, name, reused: true };
      const stdout = await docker(["run", "--detach", "--name", name,
        "--label", `${JOB_LABEL}=${jobId}`, "--label", MANAGED_LABEL, "--label", installLabel,
        "--publish", "127.0.0.1::22",
        "--memory", memory, "--cpus", cpus, "--pids-limit", String(pidsLimit),
        "--cap-drop", "ALL", ...CAPABILITIES.flatMap((cap) => ["--cap-add", cap]),
        "--security-opt", "no-new-privileges",
        "--env", "AGENTCLOUD_HOST_KEY", "--env", "AGENTCLOUD_AUTHORIZED_KEYS",
        imageId || image], { env: { AGENTCLOUD_HOST_KEY: hostPrivateKeyB64, AGENTCLOUD_AUTHORIZED_KEYS: authorizedKeys.join("\n") } });
      return { containerId: stdout.trim(), name, reused: false };
    },

    async inspect(jobId) {
      const container = await find(jobId);
      if (!container) return null;
      const [raw] = JSON.parse(await docker(["inspect", container.id]));
      return { id: raw.Id, name: raw.Name.replace(/^\//, ""), running: raw.State?.Running === true,
        status: raw.State?.Status, labels: raw.Config?.Labels || {} };
    },

    async sshPort(jobId) {
      const container = await find(jobId);
      if (!container) throw new Error("Sandbox container is absent");
      const lines = (await docker(["port", container.id, "22/tcp"])).split("\n").filter(Boolean);
      const loopback = lines.map((line) => /^127\.0\.0\.1:(\d+)$/.exec(line.trim())).find(Boolean);
      const port = loopback ? Number(loopback[1]) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Sandbox SSH port is not published on loopback");
      return port;
    },

    async replaceAuthorizedKeys(jobId, keys) {
      if (!Array.isArray(keys) || keys.length > 256) throw new Error("Invalid sandbox authorized keys");
      const normalized = keys.map(normalizePublicKey);
      const container = await find(jobId);
      if (!container || container.state !== "running") throw new Error("Sandbox container is not running");
      // Root-owned atomic replacement; no device key is placed in process arguments.
      const script = "set -eu; umask 077; target=/home/agentcloud/.ssh/authorized_keys; " +
        "tmp=$(mktemp /home/agentcloud/.ssh/.authorized_keys.XXXXXX); " +
        "trap 'rm -f \"$tmp\"' EXIT; cat > \"$tmp\"; chown agentcloud:agentcloud \"$tmp\"; " +
        "chmod 600 \"$tmp\"; mv -f \"$tmp\" \"$target\"; cat \"$target\"";
      const wanted = normalized.length ? `${normalized.join("\n")}\n` : "";
      const actual = await docker(["exec", "-i", "--user", "root", container.id, "sh", "-c", script], { input: wanted });
      if (actual !== wanted) throw new Error("Sandbox authorized key replacement could not be verified");
      return normalized;
    },

    async remove(jobId) {
      const container = await find(jobId);
      if (container) {
        try { await docker(["rm", "--force", container.id]); }
        catch (error) { if (!/No such container/i.test(error.stderr || "")) throw error; }
      }
      return { removed: Boolean(container) };
    },

    // Runs a fixed worker script as the non-root sandbox account (teardown
    // cleanup). The script is an argument, so it must never contain secrets.
    async runAsAgent(containerId, script, { timeoutMs = 30_000 } = {}) {
      if (typeof containerId !== "string" || !/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error("Invalid container ID");
      if (typeof script !== "string" || !script || script.length > 8192) throw new Error("Invalid sandbox script");
      const stdout = await docker(["exec", "--user", "agentcloud", "--env", "HOME=/home/agentcloud",
        "--workdir", "/home/agentcloud", containerId, "bash", "-c", script], { timeoutMs });
      return { code: 0, stdout };
    },

    async removeContainer(containerId) {
      if (typeof containerId !== "string" || !/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error("Invalid container ID");
      try { await docker(["rm", "--force", containerId]); }
      catch (error) { if (!/No such container/i.test(error.stderr || "")) throw error; }
    },

    async listManaged() {
      return parseRows(await docker(["ps", "--all", "--no-trunc", "--filter", `label=${MANAGED_LABEL}`,
        "--filter", `label=${installLabel}`, "--format", format]));
    },
  };
}
