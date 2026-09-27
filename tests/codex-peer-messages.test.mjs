import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createCodexSessionService } from '../lib/codex-sessions.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function fixture(db = new Database(':memory:')) {
  const calls = [];
  const notifications = new Map();
  const service = createCodexSessionService({
    db, dataDir: '/tmp/agentcloud-peer-test', sweepMs: 0,
    targets: { describe: runBoxId => ({
      runBoxId, projectId: 'project', provider: 'docker-local', profileId: 'cpu',
      state: 'ready', stopRequested: false, codexState: 'ready',
      workspacePath: '/home/agentcloud/workspace/repo', serverKeyInstalled: true,
    }) },
    runtimeFactory: async options => {
      notifications.set(options.sessionId, options.onNotification);
      return {
        async request(method, params) {
          calls.push({sessionId: options.sessionId, method, params});
          if (method === 'account/read') return {account: {type: 'chatgpt'}};
          if (method === 'thread/start' || method === 'thread/resume') return {thread: {id: `thread-${options.sessionId}`, turns: []}};
          if (method === 'turn/start') {
            options.onNotification('turn/started', {turn: {id: randomUUID()}});
            return {turn: {id: 'accepted'}};
          }
          return {};
        }, close() {}, async stop() {},
      };
    },
  });
  return {db, service, calls, notifications};
}

async function agents(f) {
  const a = f.service.initialize({projectId: 'project', agentId: 'agent-a', createdBy: 'employee', runBoxId: 'box', repoUrl: 'https://example.com/repo.git'});
  const b = f.service.initialize({projectId: 'project', agentId: 'agent-b', createdBy: 'employee', runBoxId: 'box', repoUrl: 'https://example.com/repo.git'});
  await tick();
  assert.equal(f.service.get(a.id).status, 'ready');
  assert.equal(f.service.get(b.id).status, 'ready');
  const starts = f.calls.filter(call => call.method === 'thread/start');
  assert.equal(starts.find(call => call.sessionId === a.id).params.cwd, '/home/agentcloud/workspace/worktrees/agent-a');
  assert.equal(starts.find(call => call.sessionId === b.id).params.cwd, '/home/agentcloud/workspace/worktrees/agent-b');
  return {a, b};
}

test('peer message is delivered once to the target Codex session with persistent transport states', async () => {
  const f = fixture();
  const {a, b} = await agents(f);
  const input = {toSessionId: b.id, text: 'Review the API contract', requestId: randomUUID()};
  const first = f.service.sendPeerMessage(a.id, input);
  assert.equal(first.status, 'queued');
  await tick();
  const saved = f.db.prepare('SELECT status FROM agent_inbox_message WHERE id=?').get(first.id);
  assert.equal(saved.status, 'acknowledged');
  assert.equal(f.calls.filter(call => call.sessionId === b.id && call.method === 'turn/start').length, 1);
  assert.equal(f.calls.filter(call => call.sessionId === a.id && call.method === 'turn/start').length, 0);
  assert.equal(f.service.sendPeerMessage(a.id, input).id, first.id);
  await tick();
  assert.equal(f.calls.filter(call => call.sessionId === b.id && call.method === 'turn/start').length, 1);
  assert.equal(f.service.pendingPeerMessages(b.id).length, 0);
  f.service.close(); f.db.close();
});

test('box broadcast reaches every other agent once through the existing inbox', async () => {
  const f = fixture();
  const {a, b} = await agents(f);
  const c = f.service.initialize({projectId: 'project', agentId: 'agent-c', createdBy: 'employee', runBoxId: 'box'});
  await tick();
  const input = {text: 'The API uses port 4000', requestId: randomUUID()};
  const first = f.service.broadcastPeerMessage(a.id, input);
  assert.deepEqual(new Set(first.map(message => message.toSessionId)), new Set([b.id,c.id]));
  await tick();
  assert(first.every(message => f.service.peerMessage(a.id,message.id).status === 'acknowledged'));
  assert.equal(f.calls.filter(call => call.method === 'turn/start' && call.sessionId === a.id).length, 0);
  for (const id of [b.id,c.id]) assert.equal(f.calls.filter(call => call.method === 'turn/start' && call.sessionId === id).length, 1);
  assert.deepEqual(f.service.broadcastPeerMessage(a.id,input).map(message => message.id),first.map(message => message.id));
  await tick();
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 2);
  f.service.close(); f.db.close();
});

test('busy recipients retain ordered messages and dispatch the next after turn completion', async () => {
  const f = fixture();
  const {a, b} = await agents(f);
  const first = f.service.sendPeerMessage(a.id, {toSessionId: b.id, text: 'First', requestId: randomUUID()});
  const second = f.service.sendPeerMessage(a.id, {toSessionId: b.id, text: 'Second', requestId: randomUUID()});
  await tick();
  assert.equal(f.db.prepare('SELECT status FROM agent_inbox_message WHERE id=?').get(first.id).status, 'acknowledged');
  assert.equal(f.db.prepare('SELECT status FROM agent_inbox_message WHERE id=?').get(second.id).status, 'queued');
  f.notifications.get(b.id)('turn/completed', {turn: {id: 'first', status: 'completed'}});
  await tick();
  assert.equal(f.db.prepare('SELECT status FROM agent_inbox_message WHERE id=?').get(second.id).status, 'acknowledged');
  const turns = f.calls.filter(call => call.sessionId === b.id && call.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.match(turns[0].params.input[0].text, /First/);
  assert.match(turns[1].params.input[0].text, /Second/);
  f.service.close(); f.db.close();
});

test('queued peer message survives service restart and is delivered on recipient resume', async () => {
  const db = new Database(':memory:');
  const f = fixture(db);
  const {a, b} = await agents(f);
  await f.service.action(b.id, {action: 'stop'});
  await tick();
  const message = f.service.sendPeerMessage(a.id, {toSessionId: b.id, text: 'After reconnect', requestId: randomUUID()});
  await tick();
  assert.equal(f.db.prepare('SELECT status FROM agent_inbox_message WHERE id=?').get(message.id).status, 'queued');
  f.service.close();
  const resumed = fixture(db);
  await resumed.service.action(b.id, {action: 'resume'});
  await tick();
  assert.equal(db.prepare('SELECT status FROM agent_inbox_message WHERE id=?').get(message.id).status, 'acknowledged');
  assert.equal(resumed.calls.filter(call => call.sessionId === b.id && call.method === 'turn/start').length, 1);
  resumed.service.close(); db.close();
});

test('a stopped sender cannot claim to send a peer message', async () => {
  const f = fixture();
  const {a, b} = await agents(f);
  await f.service.action(a.id, {action: 'stop'});
  assert.throws(() => f.service.sendPeerMessage(a.id, {
    toSessionId: b.id, text: 'After stop', requestId: randomUUID(),
  }), /Reconnect the sending agent/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_inbox_message').get().n, 0);
  f.service.close(); f.db.close();
});
