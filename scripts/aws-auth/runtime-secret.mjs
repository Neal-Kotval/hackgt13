// Turn the staging Secrets Manager value into shell assignments for service-start.sh.
// A plain string remains the Better Auth secret. JSON may also include BACKBOARD_API_KEY.
import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");

function shellAssign(name, value) {
  return `${name}='${String(value).replaceAll("'", "'\\''")}'`;
}

let auth = raw;
let board = "";
if (raw.startsWith("{")) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.stderr.write("Staging auth secret is not initialized.\n");
    process.exit(1);
  }
  auth = data?.BETTER_AUTH_SECRET;
  board = data?.BACKBOARD_API_KEY ?? "";
}

if (typeof auth !== "string" || auth.length < 32 || /[\r\n]/.test(auth)) {
  process.stderr.write("Staging auth secret is not initialized.\n");
  process.exit(1);
}
if (board !== "" && (typeof board !== "string" || board.length > 512 || /[\r\n]/.test(board))) {
  process.stderr.write("Staging auth secret is not initialized.\n");
  process.exit(1);
}

const lines = [shellAssign("BETTER_AUTH_SECRET", auth)];
if (board) lines.push(shellAssign("BACKBOARD_API_KEY", board));
process.stdout.write(`${lines.join("\n")}\n`);
