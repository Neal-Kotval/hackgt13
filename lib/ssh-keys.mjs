import { createHash, randomUUID } from "node:crypto";

// Device public keys only. Private keys stay on the employee's device.
const publicKeyPattern = /^ssh-ed25519 ([A-Za-z0-9+/]{68}={0,2})$/;

export function migrateSshKeys(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS employee_ssh_key (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    public_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS employee_ssh_key_active
    ON employee_ssh_key(user_id, fingerprint) WHERE revoked_at IS NULL;`);
}

export function normalizePublicKey(value) {
  if (typeof value !== "string" || value.length > 512) throw new Error("Invalid SSH public key");
  const [type, blob] = value.trim().split(/\s+/);
  const key = `${type} ${blob}`;
  const match = publicKeyPattern.exec(key);
  if (!match) throw new Error("Only ssh-ed25519 public keys are accepted");
  const raw = Buffer.from(match[1], "base64");
  // Wire format: string "ssh-ed25519" then a 32-byte key.
  if (raw.length !== 51 || raw.readUInt32BE(0) !== 11 || raw.subarray(4, 15).toString() !== "ssh-ed25519" ||
      raw.readUInt32BE(15) !== 32) throw new Error("Invalid SSH public key");
  return key;
}

export function sshFingerprint(publicKey) {
  const blob = Buffer.from(publicKey.split(" ")[1], "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function publicRow(row) {
  return { id: row.id, label: row.label, fingerprint: row.fingerprint, createdAt: row.created_at };
}

export function listSshKeys(db, userId) {
  return db.prepare(`SELECT * FROM employee_ssh_key WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC`).all(userId).map(publicRow);
}

export function registerSshKey(db, userId, { label, publicKey }) {
  if (typeof label !== "string" || !label.trim() || label.length > 80) throw new Error("Invalid key label");
  const key = normalizePublicKey(publicKey);
  const fingerprint = sshFingerprint(key);
  const existing = db.prepare(`SELECT * FROM employee_ssh_key WHERE user_id = ? AND fingerprint = ?
    AND revoked_at IS NULL`).get(userId, fingerprint);
  if (existing) return { key: publicRow(existing), created: false };
  const row = { id: randomUUID(), user_id: userId, label: label.trim(), public_key: key, fingerprint,
    created_at: new Date().toISOString() };
  db.prepare(`INSERT INTO employee_ssh_key (id, user_id, label, public_key, fingerprint, created_at)
    VALUES (@id, @user_id, @label, @public_key, @fingerprint, @created_at)`).run(row);
  return { key: publicRow(row), created: true };
}

export function revokeSshKey(db, userId, keyId) {
  const result = db.prepare(`UPDATE employee_ssh_key SET revoked_at = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), keyId, userId);
  return result.changes === 1;
}

// Keys of verified employees who can access the project: org owners/admins, or explicit project members.
export function authorizedKeysForProject(db, projectId) {
  return db.prepare(`SELECT DISTINCT k.user_id AS userId, k.public_key AS publicKey, k.fingerprint
    FROM project_organization po
    JOIN member m ON m.organizationId = po.organization_id
    JOIN user u ON u.id = m.userId AND u.emailVerified = 1
    LEFT JOIN project_membership pm ON pm.project_id = po.project_id AND pm.user_id = m.userId
    JOIN employee_ssh_key k ON k.user_id = m.userId AND k.revoked_at IS NULL
    WHERE po.project_id = ? AND (m.role IN ('owner', 'admin') OR pm.role IN ('owner', 'member'))
    ORDER BY k.created_at`).all(projectId);
}
