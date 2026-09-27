import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { migrateRunBoxJobs, saveRunBoxDecision } from '../lib/run-box-jobs.mjs';
import { getEnvironmentSettings, setEnvironmentSettings } from '../lib/environment-settings.mjs';
import { setAwsApproval } from '../lib/aws-organization-approval.mjs';

function setup() {
  const db = new Database(':memory:');
  migrateRunBoxJobs(db);
  return db;
}
function create(db, overrides = {}) {
  return saveRunBoxDecision(db, { idempotencyKey: randomUUID(), resourceRequestId: randomUUID(),
    projectId: 'project', employeeId: 'alice', organizationId: 'org', projectRole: 'owner',
    provider: 'runpod', profileId: 'runpod-budget-gpu', maxDurationMinutes: 60,
    repoUrl: 'https://example.com/repo.git', ...overrides });
}
test('default cap persists per user and includes every unreleased state', () => {
  const db = setup();
  try {
    assert.deepEqual(getEnvironmentSettings(db, 'alice'), { maxActiveEnvironments: 1, activeEnvironments: 0 });
    const first = create(db);
    for (const state of ['queued', 'allocating', 'connecting', 'verifying', 'ready', 'stopping', 'failed']) {
      db.prepare('UPDATE run_box_job SET state = ? WHERE id = ?').run(state, first.job.id);
      assert.throws(() => create(db), /active cloud environment limit \(1\)/);
      assert.equal(getEnvironmentSettings(db, 'alice').activeEnvironments, 1);
    }
    assert.equal(create(db, { employeeId: 'bob' }).job.state, 'queued');
    db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE id = ?").run(first.job.id);
    assert.equal(create(db).job.state, 'queued');
  } finally { db.close(); }
});
test('increased cap admits another job across organizations; lowering never stops jobs', () => {
  const db = setup();
  try {
    create(db);
    assert.deepEqual(setEnvironmentSettings(db, 'alice', 2), { maxActiveEnvironments: 2, activeEnvironments: 1 });
    create(db, { organizationId: 'other-org', projectId: 'other-project' });
    assert.throws(() => create(db), /limit \(2\)/);
    assert.deepEqual(setEnvironmentSettings(db, 'alice', 1), { maxActiveEnvironments: 1, activeEnvironments: 2 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_box_job WHERE state='queued'").get().n, 2);
    assert.throws(() => create(db), /limit \(1\)/);
    assert.equal(getEnvironmentSettings(db, 'bob').maxActiveEnvironments, 1);
  } finally { db.close(); }
});
test('AWS and Runpod share a cap; local and attached hosts do not count', () => {
  const db = setup();
  try {
    db.exec("CREATE TABLE organization (id TEXT PRIMARY KEY); INSERT INTO organization VALUES ('org')");
    setAwsApproval(db, { organizationId: 'org', approved: true, maxRunMinutes: 120, monthlyMinutes: 1200, actorId: 'admin' });
    create(db, { provider: 'docker-local', profileId: 'local-docker-sandbox' });
    create(db, { provider: 'ssh-host' });
    create(db, { provider: 'aws-ec2' });
    assert.throws(() => create(db), /limit \(1\)/);
    setEnvironmentSettings(db, 'alice', 2);
    create(db);
    assert.equal(getEnvironmentSettings(db, 'alice').activeEnvironments, 2);
  } finally { db.close(); }
});
test('invalid preferences cannot change the saved cap', () => {
  const db = setup();
  try {
    setEnvironmentSettings(db, 'alice', 3);
    for (const value of [0, 6, -1, 1.5, '2', null, undefined, NaN, Infinity])
      assert.throws(() => setEnvironmentSettings(db, 'alice', value), /integer from 1 to 5/);
    assert.equal(getEnvironmentSettings(db, 'alice').maxActiveEnvironments, 3);
  } finally { db.close(); }
});

test('only accepted AWS termination frees capacity before cleanup finishes', () => {
  const db = setup();
  try {
    db.exec("CREATE TABLE organization (id TEXT PRIMARY KEY); INSERT INTO organization VALUES ('org')");
    setAwsApproval(db, { organizationId: 'org', approved: true, maxRunMinutes: 120, monthlyMinutes: 1200, actorId: 'admin' });
    const { job } = create(db, { provider: 'aws-ec2' });
    const now = new Date().toISOString();
    // A user stop request is not provider acceptance.
    db.prepare("UPDATE run_box_job SET state = 'stopping', stop_requested_at = ? WHERE id = ?").run(now, job.id);
    assert.equal(getEnvironmentSettings(db, 'alice').activeEnvironments, 1);
    assert.throws(() => create(db), /cloud environment limit/);
    db.prepare('UPDATE run_box_job SET termination_requested_at = ? WHERE id = ?').run(now, job.id);
    assert.equal(getEnvironmentSettings(db, 'alice').activeEnvironments, 0);
    // Acceptance on a different state must not bypass the cap.
    db.prepare("UPDATE run_box_job SET state = 'failed' WHERE id = ?").run(job.id);
    assert.equal(getEnvironmentSettings(db, 'alice').activeEnvironments, 1);
    db.prepare("UPDATE run_box_job SET state = 'stopping' WHERE id = ?").run(job.id);
    const runpod = create(db).job;
    // Runpod has no accepted-termination contract; even a stray timestamp cannot free it.
    db.prepare("UPDATE run_box_job SET state = 'stopping', termination_requested_at = ? WHERE id = ?").run(now, runpod.id);
    assert.equal(getEnvironmentSettings(db, 'alice').activeEnvironments, 1);
    assert.throws(() => create(db), /cloud environment limit/);
  } finally { db.close(); }
});
