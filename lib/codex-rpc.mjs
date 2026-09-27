// JSON-RPC stdio client for `codex app-server` (HAC-153). Extracted from
// createCodexDockerRuntime without behavior change; the Docker and SSH
// runtimes share it.
//
// - Newline-delimited JSON frames, each at most 2 MiB.
// - Server requests are answered with a decline (approvals) or a
//   not-supported error; this client never grants interactive requests.
// - Server error text is never passed on: it can echo credentials.
// - A request timeout closes the transport so an ambiguous request cannot
//   continue on the same connection.
// - Close ends stdin first and kills the process only after 5 seconds, so EOF
//   can reach app-server (killing a Docker CLI or ssh client immediately can
//   strand the remote process).

export const MAX_FRAME = 2 * 1024 * 1024;

export function createCodexRpcClient(child, {
  onNotification = () => {}, onExit = () => {}, requestTimeoutMs = 30_000,
  connectErrorMessage = "Could not connect to the Codex container.", killDelayMs = 5_000,
} = {}) {
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
    // Let EOF reach app-server before terminating the local client process.
    const timer = setTimeout(() => child.kill(), killDelayMs);
    timer.unref?.();
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
  child.on("error", () => finish(connectErrorMessage));
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
  async function initialize() {
    try {
      await request("initialize", { clientInfo: { name: "agentcloud", title: "AgentCloud", version: "0.1.0" } });
      send({ method: "initialized", params: {} });
    } catch (error) { close(); throw error; }
  }
  return { request, close, fail, initialize, get closed() { return closed; } };
}
