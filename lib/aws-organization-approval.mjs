const MAX_MONTHLY_MINUTES = 1200;

export function migrateAwsOrganizationApprovals(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS aws_organization_approval (
    organization_id TEXT PRIMARY KEY,
    approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
    max_run_minutes INTEGER NOT NULL CHECK(max_run_minutes IN (60, 120)),
    monthly_minutes INTEGER NOT NULL CHECK(monthly_minutes BETWEEN 60 AND 1200),
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS aws_organization_approval_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
    max_run_minutes INTEGER NOT NULL,
    monthly_minutes INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
}

export function awsApproval(db, organizationId) {
  migrateAwsOrganizationApprovals(db);
  return db.prepare(`SELECT organization_id AS organizationId, approved,
    max_run_minutes AS maxRunMinutes, monthly_minutes AS monthlyMinutes,
    approved_by AS approvedBy, approved_at AS approvedAt
    FROM aws_organization_approval WHERE organization_id = ?`).get(organizationId) || null;
}

export function awsMinutesUsed(db, organizationId, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  return db.prepare(`SELECT COALESCE(SUM(max_duration_minutes), 0) AS minutes
    FROM run_box_decision WHERE organization_id = ? AND provider = 'aws-ec2'
      AND outcome = 'approved' AND substr(created_at, 1, 7) = ?`)
    .get(organizationId, month).minutes;
}

export function awsApprovalReason(db, organizationId, durationMinutes, now = new Date()) {
  const approval = awsApproval(db, organizationId);
  if (!approval?.approved) return "Platform approval required for AWS compute";
  if (durationMinutes > approval.maxRunMinutes) return "Run exceeds the approved AWS duration";
  if (awsMinutesUsed(db, organizationId, now) + durationMinutes > approval.monthlyMinutes)
    return "Organization monthly AWS compute allowance exhausted";
  return null;
}

export function setAwsApproval(db, { organizationId, approved, maxRunMinutes, monthlyMinutes, actorId }) {
  if (typeof organizationId !== "string" || !organizationId || organizationId.length > 256 ||
      typeof actorId !== "string" || !actorId || actorId.length > 256 ||
      typeof approved !== "boolean" || ![60, 120].includes(maxRunMinutes) ||
      !Number.isInteger(monthlyMinutes) || monthlyMinutes < 60 ||
      monthlyMinutes > MAX_MONTHLY_MINUTES || monthlyMinutes % 60 !== 0)
    throw new Error("Invalid AWS organization approval");
  migrateAwsOrganizationApprovals(db);
  const now = new Date().toISOString();
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM organization WHERE id = ?").get(organizationId))
      throw new Error("Organization not found");
    db.prepare(`INSERT INTO aws_organization_approval
      (organization_id, approved, max_run_minutes, monthly_minutes, approved_by, approved_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id) DO UPDATE SET approved = excluded.approved,
        max_run_minutes = excluded.max_run_minutes, monthly_minutes = excluded.monthly_minutes,
        approved_by = excluded.approved_by, approved_at = excluded.approved_at`)
      .run(organizationId, Number(approved), maxRunMinutes, monthlyMinutes, actorId, now);
    db.prepare(`INSERT INTO aws_organization_approval_event
      (organization_id, approved, max_run_minutes, monthly_minutes, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(organizationId, Number(approved), maxRunMinutes, monthlyMinutes, actorId, now);
    return awsApproval(db, organizationId);
  })();
}

export function listAwsApprovals(db) {
  migrateAwsOrganizationApprovals(db);
  return db.prepare(`SELECT o.id, o.name, o.slug,
    COALESCE(a.approved, 0) AS approved,
    COALESCE(a.max_run_minutes, 60) AS maxRunMinutes,
    COALESCE(a.monthly_minutes, 60) AS monthlyMinutes,
    a.approved_by AS approvedBy, a.approved_at AS approvedAt
    FROM organization o LEFT JOIN aws_organization_approval a ON a.organization_id = o.id
    ORDER BY o.name, o.id`).all().map((row) => ({
      ...row, approved: Boolean(row.approved), usedMinutes: awsMinutesUsed(db, row.id),
    }));
}
