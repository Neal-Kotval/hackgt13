// Turn the staging Secrets Manager value into exported shell assignments for service-start.sh,
// so the npm/next processes it execs inherit them.
// A plain string remains the Better Auth secret. JSON may also include BACKBOARD_API_KEY and the
// SMTP_* settings that turn on real email delivery (invitations, verification).
import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");

function shellAssign(name, value) {
  return `export ${name}='${String(value).replaceAll("'", "'\\''")}'`;
}

const SMTP_FIELDS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"];
let auth = raw;
let board = "";
let smtp = {};
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
  smtp = Object.fromEntries(SMTP_FIELDS.filter((name) => data?.[name] !== undefined).map((name) => [name, data[name]]));
}

if (typeof auth !== "string" || auth.length < 32 || /[\r\n]/.test(auth)) {
  process.stderr.write("Staging auth secret is not initialized.\n");
  process.exit(1);
}
if (board !== "" && (typeof board !== "string" || board.length > 512 || /[\r\n]/.test(board))) {
  process.stderr.write("Staging auth secret is not initialized.\n");
  process.exit(1);
}

for (const value of Object.values(smtp)) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\r\n]/.test(value)) {
    process.stderr.write("Staging SMTP settings are invalid.\n");
    process.exit(1);
  }
}
if (Object.keys(smtp).length && (!smtp.SMTP_HOST || !smtp.SMTP_FROM || Boolean(smtp.SMTP_USER) !== Boolean(smtp.SMTP_PASSWORD))) {
  process.stderr.write("Staging SMTP settings are incomplete.\n");
  process.exit(1);
}

const lines = [shellAssign("BETTER_AUTH_SECRET", auth)];
if (board) lines.push(shellAssign("BACKBOARD_API_KEY", board));
for (const [name, value] of Object.entries(smtp)) lines.push(shellAssign(name, value));
process.stdout.write(`${lines.join("\n")}\n`);
