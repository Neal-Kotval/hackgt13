import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { createCodexRpcClient, MAX_FRAME } from "./codex-rpc.mjs";

export const CODEX_IMAGE = "agentcloud-codex:0.157.1";
const LABEL = "com.agentcloud.codex";

function execute(args, timeout = 30_000) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, maxBuffer: MAX_FRAME, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code || 1 : 0, stdout, stderr });
    });
  });
}

function names(sessionId, installId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)
    || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(installId)) throw new Error("Invalid Codex session identity.");
  const container = `agentcloud-codex-${installId}-${sessionId}`;
  return { container, volume: `${container}-home` };
}

async function checked(exec, args, message, timeout) {
  const result = await exec(args, timeout);
  if (result.code !== 0) throw new Error(message);
  return result.stdout;
}

async function inspect(exec, kind, name) {
  const result = await exec([kind, "inspect", name]);
  if (result.code === 0) {
    try { return JSON.parse(result.stdout)[0]; } catch { throw new Error("Docker returned an invalid inspection response."); }
  }
  if (/no such (object|container|volume)/i.test(result.stderr || "")) return null;
  throw new Error("Cannot inspect Docker resources. Check that Docker is running and accessible.");
}

function assertOwner(labels, installId, sessionId) {
  if (labels?.[`${LABEL}.install`] !== installId || labels?.[`${LABEL}.session`] !== sessionId) {
    throw new Error("Existing Docker resource does not belong to this Codex session.");
  }
}

function assertContainer(storedContainer, { installId, sessionId, volume, imageId }) {
  assertOwner(storedContainer.Config?.Labels, installId, sessionId);
  const mounts = storedContainer.Mounts || [];
  if ((imageId && storedContainer.Image !== imageId) || storedContainer.Config?.Image !== CODEX_IMAGE || storedContainer.Config?.User !== "node"
    || mounts.length !== 1 || mounts[0].Type !== "volume" || mounts[0].Name !== volume
    || mounts[0].Destination !== "/home/node" || !mounts[0].RW
    || storedContainer.HostConfig?.Privileged || !["default", "bridge"].includes(storedContainer.HostConfig?.NetworkMode)
    || !storedContainer.HostConfig?.ReadonlyRootfs
    || storedContainer.HostConfig?.Memory !== 2 * 1024 * 1024 * 1024
    || storedContainer.HostConfig?.NanoCpus !== 2_000_000_000
    || storedContainer.HostConfig?.PidsLimit !== 256
    || storedContainer.HostConfig?.CapDrop?.length !== 1 || storedContainer.HostConfig.CapDrop[0] !== "ALL"
    || !storedContainer.HostConfig?.SecurityOpt?.includes("no-new-privileges")
    || Object.keys(storedContainer.HostConfig?.PortBindings || {}).length) {
    throw new Error("Existing Codex container configuration does not match the isolated runtime.");
  }
}

function assertVolume(value, installId, sessionId) {
  assertOwner(value?.Labels, installId, sessionId);
  if (value.Driver !== "local" || Object.keys(value.Options || {}).length) {
    throw new Error("Existing Codex volume must use local storage without host bind options.");
  }
}

/** Stop only existing resources, even when their app-server cannot initialize. */
export async function stopCodexContainer({ sessionId, installId }, { exec = execute } = {}) {
  const { container, volume } = names(sessionId, installId);
  const current = await inspect(exec, "container", container);
  if (!current) return { stopped: true };
  assertContainer(current, { installId, sessionId, volume });
  assertVolume(await inspect(exec, "volume", volume), installId, sessionId);
  if (current.State?.Running) await checked(exec, ["stop", "--time", "10", container], "Could not stop the Codex container.");
  return { stopped: true };
}

export async function prepareCodexImage({ exec = execute } = {}) {
  const context = path.resolve("infra/codex");
  await checked(exec, ["build", "--tag", CODEX_IMAGE, context], "Could not build the Codex image. Check Docker and registry access.", 600_000);
  return { image: CODEX_IMAGE };
}

/** Local Docker only. Credentials travel over stdin, never Docker arguments or host mounts. */
export async function createCodexDockerRuntime(
  { sessionId, installId, onNotification = () => {}, onExit = () => {} },
  { exec = execute, spawnProcess = spawn, requestTimeoutMs = 30_000 } = {},
) {
  const { container, volume } = names(sessionId, installId);
  const imageId = (await checked(exec, ["image", "inspect", "--format", "{{.Id}}", CODEX_IMAGE],
    "Codex image is unavailable. Run the local Codex image setup first.")).trim();
  const labels = ["--label", `${LABEL}.install=${installId}`, "--label", `${LABEL}.session=${sessionId}`];
  const storedVolume = await inspect(exec, "volume", volume);
  if (storedVolume) assertVolume(storedVolume, installId, sessionId);
  else await checked(exec, ["volume", "create", ...labels, volume], "Could not create the Codex workspace volume.");
  const storedContainer = await inspect(exec, "container", container);
  if (storedContainer) {
    assertContainer(storedContainer, { installId, sessionId, volume, imageId });
    if (!storedContainer.State?.Running) await checked(exec, ["start", container], "Could not restart the Codex container.");
  } else {
    await checked(exec, ["run", "--detach", "--name", container, ...labels,
      "--init", "--user", "node", "--memory", "2g", "--cpus", "2", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--mount", `type=volume,source=${volume},target=/home/node`,
      CODEX_IMAGE], "Could not start the Codex container.");
  }
  const child = spawnProcess("docker", ["exec", "-i", "--user", "node", "--workdir", "/home/node/workspace", container, "codex", "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const client = createCodexRpcClient(child, { onNotification, onExit, requestTimeoutMs });
  const { request, close } = client;
  await client.initialize();
  return {
    request,
    close,
    async stop() {
      close();
      await checked(exec, ["stop", "--time", "10", container], "Could not stop the Codex container.");
    },
  };
}
