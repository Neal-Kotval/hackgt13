import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectChatRuns, listChatRuns } from '../lib/chat-runs.mjs';

const session = { id: 'chat', projectId: 'project', status: 'ready', target: { kind: 'runBox', runBoxId: 'box', profileId: 'local-docker-sandbox', provider: 'docker-local', state: 'ready' } };
const e = (id, kind, text) => ({ id: String(id), kind, text, createdAt: `2026-09-27T00:00:${String(id).padStart(2, '0')}.000Z` });
const user = id => ({ ...e(id, 'user', 'Review my changes'), actorName: 'Nathan' });

test('setup, empty sessions and truncated leading output do not manufacture runs', () => {
  for (const events of [[], [e(1, 'status', 'Codex is ready')], [e(1, 'assistant', 'Earlier answer'), e(2, 'status', 'Turn completed')]]) {
    assert.deepEqual(projectChatRuns({ session, events }), []);
  }
});

test('each user request has a stable identity and keeps its own confirmed outcome', () => {
  const events = [user(1), e(2, 'assistant', 'Done'), e(3, 'status', 'Turn completed'), user(4), e(5, 'status', 'Turn failed'), user(6), e(7, 'status', 'Turn interrupted'), e(8, 'error', 'Connection failed')];
  const runs = projectChatRuns({ session: { ...session, status: 'stopped' }, events });
  assert.deepEqual(runs.map(run => run.status), ['completed', 'failed', 'stopped']);
  assert.equal(runs[0].id, 'chat:1');
  assert.equal(runs[0].actorName, 'Nathan');
  assert.equal(runs[0].runBoxId, 'box');
  assert.equal(runs[0].finishedAt, events[2].createdAt);
  assert.equal(runs[2].events.length, 2, 'later connection errors are outside a finished request');
});

test('only latest unfinished request can be running; unknown results are never fabricated', () => {
  const events = [user(1), e(2, 'assistant', 'Answer without completion'), user(3)];
  assert.deepEqual(projectChatRuns({ session: { ...session, status: 'running' }, events }).map(run => run.status), ['unknown', 'running']);
  for (const status of ['ready', 'error', 'stopped', 'initializing']) {
    const runs = projectChatRuns({ session: { ...session, status }, events });
    assert.equal(runs[1].status, 'unknown');
    assert.equal(runs[1].finishedAt, null);
  }
});

test('explicit environment/session shutdown ends unfinished request but preserves completed work', () => {
  for (const text of ['Codex session closed. The environment and its workspace are unchanged.', 'Docker box stopped. Workspace and Codex history retained.', 'Environment stopped. The Codex session on it was closed.']) {
    const runs = projectChatRuns({ session, events: [user(1), e(2, 'status', 'Turn completed'), user(3), e(4, 'status', text)] });
    assert.deepEqual(runs.map(run => run.status), ['completed', 'stopped']);
  }
});

test('list uses safe snapshots, filters project, returns newest first and excludes private fields', () => {
  const snapshots = {
    a: { session: { ...session, id: 'a', privateSecret: 'hidden' }, events: [user(1)] },
    b: { session: { ...session, id: 'b' }, events: [{ ...user(2), privateSecret: 'hidden', text: '[redacted]' }] },
  };
  const service = {
    list: () => [snapshots.a.session, snapshots.b.session, { id: 'foreign', projectId: 'other' }],
    snapshot: id => { assert.notEqual(id, 'foreign'); return snapshots[id]; },
  };
  const runs = listChatRuns(service, 'project');
  assert.deepEqual(runs.map(run => run.id), ['b:2', 'a:1']);
  assert.equal(runs[0].prompt, '[redacted]');
  assert.equal(JSON.stringify(runs).includes('hidden'), false);
});


test('retired standalone local sessions with saved prompts are excluded', () => {
  const local = { ...session, id: 'local', target: { kind: 'local' } };
  const missingEnvironment = { ...session, id: 'missing', target: { kind: 'runBox', runBoxId: null } };
  const service = {
    list: () => [local, missingEnvironment, session],
    snapshot: id => {
      assert.equal(id, session.id, 'only environment-backed conversations are read');
      return { session, events: [user(1)] };
    },
  };
  const runs = listChatRuns(service, 'project');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runBoxId, 'box');
});
