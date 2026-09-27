import { execFile, spawn } from "node:child_process";
import path from "node:path";

export const CODEX_IMAGE = "agentcloud-codex:0.157.1";
const LABEL = "com.agentcloud.codex";
const MAX_FRAME = 2 * 1024 * 1024;

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
  let sequence = 0;
  let closed = false;
  let buffer = "";
  const pending = new Map();
  function finish(message) {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear();
    try { onExit({ message }); } catch { /* Consumer failures must not crash the server. */ }
  }
  function send(message) {
    const data = JSON.stringify(message);
    if (Buffer.byteLength(data) > MAX_FRAME) throw new Error("Codex request exceeds the message limit.");
    if (closed || child.stdin.destroyed) throw new Error("Codex connection is closed.");
    child.stdin.write(`${data}\n`);
  }
  let ending = false;
  function endProcess() {
    if (ending) return;
    ending = true;
    child.stdin.end();
    // Let EOF reach app-server before terminating the Docker CLI; killing the CLI
    // immediately can strand its exec process inside the container.
    const timer = setTimeout(() => child.kill(), 5_000);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }
  function close() { finish("Codex connection closed."); endProcess(); }
  function fail(message) { finish(message); endProcess(); }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (closed) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_FRAME) { fail("Codex response exceeds the message limit."); return; }
      let message;
      try { message = JSON.parse(line); } catch { fail("Codex sent an invalid protocol message."); return; }
      if (!message || typeof message !== "object") { fail("Codex sent an invalid protocol message."); return; }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          try {
            if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) send({ id: message.id, result: { decision: "decline" } });
            else send({ id: message.id, error: { code: -32601, message: "This client does not support interactive server requests." } });
          } catch { fail("Could not answer the Codex server request."); return; }
        } else {
          try { onNotification(message.method, message.params ?? {}); } catch { /* Isolate subscribers. */ }
        }
      } else if (pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        // Server errors can echo input including authentication secrets. Never propagate their text.
        if (message.error) entry.reject(new Error("Codex rejected the request. Check authentication and session state."));
        else entry.resolve(message.result);
      }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) fail("Codex response exceeds the message limit.");
  });
  child.stderr.resume(); // Drain without recording credentials or unbounded debug output.
  child.on("error", () => finish("Could not connect to the Codex container."));
  child.on("exit", () => finish("Codex process exited. Reconnect to continue."));
  child.stdin.on("error", () => fail("Codex connection is unavailable."));
  function request(method, params = {}) {
    if (typeof method !== "string" || !method.length) return Promise.reject(new Error("Invalid Codex method."));
    if (closed) return Promise.reject(new Error("Codex connection is closed."));
    if (pending.size >= 32) return Promise.reject(new Error("Too many pending Codex requests."));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Codex request timed out. Reconnect before retrying."));
        fail("Codex connection closed after a request timeout.");
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  try {
    await request("initialize", { clientInfo: { name: "agentcloud", title: "AgentCloud", version: "0.1.0" } });
    send({ method: "initialized", params: {} });
  } catch (error) { close(); throw error; }
  return {
    request,
    close,
    async stop() {
      close();
      await checked(exec, ["stop", "--time", "10", container], "Could not stop the Codex container.");
    },
  };
}
