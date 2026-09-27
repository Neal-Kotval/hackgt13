import { normalizePublicKey } from "./ssh-keys.mjs";

export function migrateRunBoxSsh(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS run_box_ssh_endpoint (
    job_id TEXT PRIMARY KEY REFERENCES run_box_job(id),
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
    username TEXT NOT NULL,
    host_public_key TEXT NOT NULL,
    authorized_fingerprints TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );`);
}

// `authorized_fingerprints` is a JSON array of member device key fingerprints.
// HAC-153: the backend's Codex runner key, when installed, is stored in the same
// array tagged `server:SHA256:...`. getRunBoxSshEndpoint returns it separately as
// `serverFingerprint`, so `authorizedFingerprints` keeps meaning members only
// (the connection API matches a device key against it).
const SERVER_TAG = "server:";
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function recordRunBoxSshEndpoint(db, jobId, { host, port, username, hostPublicKey, authorizedFingerprints,
  serverFingerprint = null }) {
  if (typeof host !== "string" || !/^[A-Za-z0-9.:-]{1,253}$/.test(host)) throw new Error("Invalid SSH host");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH port");
  if (typeof username !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) throw new Error("Invalid SSH user");
  if (!Array.isArray(authorizedFingerprints) || authorizedFingerprints.some((item) => !FINGERPRINT.test(item)))
    throw new Error("Invalid authorized key fingerprints");
  if (serverFingerprint !== null && !FINGERPRINT.test(serverFingerprint)) throw new Error("Invalid server key fingerprint");
  const stored = serverFingerprint ? [...authorizedFingerprints, `${SERVER_TAG}${serverFingerprint}`] : authorizedFingerprints;
  const hostKey = normalizePublicKey(hostPublicKey);
  db.prepare(`INSERT INTO run_box_ssh_endpoint
    (job_id, host, port, username, host_public_key, authorized_fingerprints, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET host=excluded.host, port=excluded.port, username=excluded.username,
      host_public_key=excluded.host_public_key, authorized_fingerprints=excluded.authorized_fingerprints,
      recorded_at=excluded.recorded_at`)
    .run(jobId, host, port, username, hostKey, JSON.stringify(stored), new Date().toISOString());
}

export function getRunBoxSshEndpoint(db, jobId) {
  const row = db.prepare("SELECT * FROM run_box_ssh_endpoint WHERE job_id = ?").get(jobId);
  if (!row) return null;
  const stored = JSON.parse(row.authorized_fingerprints);
  const server = stored.find((item) => item.startsWith(SERVER_TAG));
  return { jobId: row.job_id, host: row.host, port: row.port, username: row.username,
    hostPublicKey: row.host_public_key, authorizedFingerprints: stored.filter((item) => !item.startsWith(SERVER_TAG)),
    serverFingerprint: server ? server.slice(SERVER_TAG.length) : null, recordedAt: row.recorded_at };
}

export function knownHostsLine({ host, port, hostPublicKey }) {
  return `${port === 22 ? host : `[${host}]:${port}`} ${hostPublicKey}`;
}
