// Environment names, visibility, and deletion (docs/environment-model-contract.md).
//
// `run_box_metadata` sits beside `run_box_job` without altering its columns. A job
// with no metadata row predates this table and is treated as public and unnamed,
// which preserves the behavior those jobs were created under. New jobs get a row
// with visibility `private` unless the creator asks for `public`.
//
// Deletion only hides a job: its run_box_job, run_box_transition, and decision
// rows stay. The DELETE route requests a stop first, so the worker still
// terminates the resource and records release evidence.

export const VISIBILITIES = Object.freeze(["private", "public"]);
export const DEFAULT_NEW_VISIBILITY = "private";
export const LEGACY_VISIBILITY = "public";
export const NAME_MAX_LENGTH = 60;

export function migrateRunBoxMetadata(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_box_metadata (
      job_id TEXT PRIMARY KEY REFERENCES run_box_job(id),
      name TEXT,
      visibility TEXT NOT NULL CHECK(visibility IN ('private', 'public')),
      deleted_at TEXT,
      deleted_by TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_box_metadata_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES run_box_job(id),
      actor TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('create', 'rename', 'visibility', 'delete')),
      detail TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

// Returns the trimmed name, or null to clear it. Throws Error("Invalid environment name").
export function normalizeRunBoxName(value) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid environment name");
  const name = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > NAME_MAX_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(name))
    throw new Error("Invalid environment name");
  return name;
}

export function normalizeRunBoxVisibility(value) {
  if (!VISIBILITIES.includes(value)) throw new Error("Invalid environment visibility");
  return value;
}

export function getRunBoxMetadata(db, jobId) {
  return db.prepare("SELECT * FROM run_box_metadata WHERE job_id = ?").get(jobId) || null;
}

// The effective view of a job's metadata; a missing row means a legacy public job.
export function effectiveRunBoxMetadata(row) {
  return {
    name: row?.name ?? null,
    visibility: row?.visibility ?? LEGACY_VISIBILITY,
    deletedAt: row?.deleted_at ?? null,
    deletedBy: row?.deleted_by ?? null,
    legacy: !row,
  };
}

function event(db, jobId, actor, action, detail, at) {
  db.prepare(`INSERT INTO run_box_metadata_event (job_id, actor, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(jobId, actor, action, detail === undefined ? null : JSON.stringify(detail), at);
}

// Records a new job's metadata once. A retried create with the same idempotency key
// finds the existing row and leaves it unchanged.
export function createRunBoxMetadata(db, jobId, actor, { name = null, visibility = DEFAULT_NEW_VISIBILITY } = {}) {
  const values = { name: normalizeRunBoxName(name), visibility: normalizeRunBoxVisibility(visibility) };
  return db.transaction(() => {
    const existing = getRunBoxMetadata(db, jobId);
    if (existing) return existing;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO run_box_metadata (job_id, name, visibility, deleted_at, deleted_by, updated_at)
      VALUES (?, ?, ?, NULL, NULL, ?)`).run(jobId, values.name, values.visibility, now);
    event(db, jobId, actor, "create", values, now);
    return getRunBoxMetadata(db, jobId);
  })();
}

// Applies `name` and/or `visibility` (each optional). A legacy job gains a row that
// keeps its public default unless visibility is part of the change.
export function updateRunBoxMetadata(db, jobId, actor, changes) {
  const next = {};
  if (Object.hasOwn(changes, "name")) next.name = normalizeRunBoxName(changes.name);
  if (Object.hasOwn(changes, "visibility")) next.visibility = normalizeRunBoxVisibility(changes.visibility);
  return db.transaction(() => {
    const before = effectiveRunBoxMetadata(getRunBoxMetadata(db, jobId));
    if (before.deletedAt) throw new Error("Environment was deleted");
    const now = new Date().toISOString();
    const name = Object.hasOwn(next, "name") ? next.name : before.name;
    const visibility = next.visibility ?? before.visibility;
    db.prepare(`INSERT INTO run_box_metadata (job_id, name, visibility, deleted_at, deleted_by, updated_at)
      VALUES (?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(job_id) DO UPDATE SET name = excluded.name, visibility = excluded.visibility,
        updated_at = excluded.updated_at`).run(jobId, name, visibility, now);
    if (name !== before.name) event(db, jobId, actor, "rename", { from: before.name, to: name }, now);
    if (visibility !== before.visibility) event(db, jobId, actor, "visibility", { from: before.visibility, to: visibility }, now);
    return getRunBoxMetadata(db, jobId);
  })();
}

// Marks a job deleted once; later calls keep the first time and actor.
export function markRunBoxDeleted(db, jobId, actor) {
  return db.transaction(() => {
    const before = getRunBoxMetadata(db, jobId);
    if (before?.deleted_at) return before;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO run_box_metadata (job_id, name, visibility, deleted_at, deleted_by, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by,
        updated_at = excluded.updated_at`).run(jobId, LEGACY_VISIBILITY, now, actor, now);
    event(db, jobId, actor, "delete", undefined, now);
    return getRunBoxMetadata(db, jobId);
  })();
}
