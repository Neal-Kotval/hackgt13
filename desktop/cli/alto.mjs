#!/usr/bin/env node
import { createConnection } from "node:net";
import { lstat, mkdir, symlink, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "install") {
  try {
    const launcher = process.env.ALTO_LAUNCHER_PATH;
    if (!launcher || !path.isAbsolute(launcher)) throw new Error("Run install using the alto launcher inside the installed desktop app.");
    const target = path.join(homedir(), ".local", "bin", "alto");
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const existing = await lstat(target);
      if (!existing.isSymbolicLink() || await readlink(target) !== launcher) throw new Error(`Refusing to replace ${target}; remove it yourself if you want to install this launcher.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await symlink(launcher, target);
    }
    console.log(`Installed ${target}. Add ~/.local/bin to your PATH if needed.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (args.length === 0 || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]))) {
  console.log("Usage: alto ssh <environment-id>\n       alto install\n\nOpen a trusted SSH shell using the running, signed-in alto desktop app.\nCopy the environment ID from alto. No separate SSH key registration is needed.");
} else if (args.length !== 2 || args[0] !== "ssh" || !/^[A-Za-z0-9_-]{1,128}$/.test(args[1])) {
  console.error("Usage: alto ssh <environment-id>");
  process.exitCode = 2;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("alto ssh requires an interactive terminal.");
  process.exitCode = 2;
} else {
  const socket = createConnection(path.join(homedir(), ".alto", "desktop.sock"));
  let buffer = "";
  let ready = false;
  let finished = false;
  const wasRaw = process.stdin.isRaw;
  const send = (frame) => {
    if (socket.destroyed || socket.writableEnded) return;
    if (socket.writableLength > 1024 * 1024) { finish(1, "Desktop is not accepting terminal input."); return; }
    socket.write(JSON.stringify(frame) + "\n");
  };
  const input = (data) => {
    for (let i = 0; i < data.length;) {
      let end = Math.min(i + 16384, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      send({ type: "input", data: data.slice(i, end) });
      i = end;
    }
  };
  const resize = () => send({ type: "resize", cols: process.stdout.columns, rows: process.stdout.rows });
  const finish = (code, message) => {
    if (finished) return;
    finished = true;
    process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.off("data", input);
    process.stdin.pause();
    process.stdout.off("resize", resize);
    if (message) process.stderr.write(`\r\n${message}\r\n`);
    socket.destroy();
    process.exitCode = code;
  };
  socket.setEncoding("utf8");
  socket.setTimeout(10000, () => finish(1, "alto desktop did not respond. Restart the app and try again."));
  socket.on("connect", () => send({ type: "open", runBoxId: args[1], cols: process.stdout.columns, rows: process.stdout.rows }));
  socket.on("error", () => finish(1, "Open the alto desktop app and sign in, then run this command again."));
  socket.on("close", () => finish(1, "The desktop connection closed."));
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { finish(1, "Invalid desktop response."); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.type === "status") {
          socket.setTimeout(0); // Network authorization can take several minutes.
          process.stderr.write(`${frame.message}\r\n`);
        } else if (frame.type === "ready" && !ready) {
          ready = true;
          socket.setTimeout(0);
          process.stdin.setRawMode(true);
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", input);
          process.stdin.resume();
          process.stdout.on("resize", resize);
          resize();
        } else if (frame.type === "data") {
          if (!process.stdout.write(frame.data)) {
            socket.pause();
            process.stdout.once("drain", () => socket.resume());
          }
        } else if (frame.type === "closed") finish(frame.error ? 1 : 0, frame.error);
        else if (frame.type === "error") finish(1, frame.message);
        else throw new Error();
      } catch { finish(1, "Invalid desktop response."); }
    }
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => finish(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal])));
  process.stdin.once("end", () => finish(0));
  process.once("exit", () => { if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false); });
}
