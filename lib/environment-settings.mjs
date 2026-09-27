export const DEFAULT_MAX_ACTIVE_ENVIRONMENTS = 1;
export const MAX_ACTIVE_ENVIRONMENTS = 5;

export function migrateEnvironmentSettings(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS employee_environment_settings (
    employee_id TEXT PRIMARY KEY,
    max_active_environments INTEGER NOT NULL CHECK(max_active_environments BETWEEN 1 AND 5),
    updated_at TEXT NOT NULL
  )`);
}

export function getEnvironmentSettings(db, employeeId) {
  migrateEnvironmentSettings(db);
  const preference = db.prepare("SELECT max_active_environments FROM employee_environment_settings WHERE employee_id = ?").get(employeeId);
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM run_box_job j
    JOIN run_box_decision d ON d.id = j.decision_id
    WHERE d.employee_id = ? AND j.provider IN ('aws-ec2', 'runpod') AND j.state != 'stopped'`).get(employeeId);
  return { maxActiveEnvironments: preference?.max_active_environments ?? DEFAULT_MAX_ACTIVE_ENVIRONMENTS,
    activeEnvironments: count };
}

export function setEnvironmentSettings(db, employeeId, maxActiveEnvironments) {
  if (!Number.isInteger(maxActiveEnvironments) || maxActiveEnvironments < 1 || maxActiveEnvironments > MAX_ACTIVE_ENVIRONMENTS)
    throw Object.assign(new Error(`Maximum active environments must be an integer from 1 to ${MAX_ACTIVE_ENVIRONMENTS}`), { status: 400, expose: true });
  migrateEnvironmentSettings(db);
  return db.transaction(() => {
    db.prepare(`INSERT INTO employee_environment_settings (employee_id, max_active_environments, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(employee_id) DO UPDATE SET
      max_active_environments = excluded.max_active_environments, updated_at = excluded.updated_at`)
      .run(employeeId, maxActiveEnvironments, new Date().toISOString());
    return getEnvironmentSettings(db, employeeId);
  }).immediate();
}

export function assertEnvironmentCapacity(db, employeeId) {
  const settings = getEnvironmentSettings(db, employeeId);
  if (settings.activeEnvironments >= settings.maxActiveEnvironments)
    throw Object.assign(new Error(`Your active cloud environment limit (${settings.maxActiveEnvironments}) has been reached. Stop an environment or increase the limit in User settings. Stopping and failed environments count until their resources are released.`),
      { status: 409, expose: true });
}
