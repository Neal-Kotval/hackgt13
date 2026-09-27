import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { migrateCodexSessions } from '../lib/codex-sessions.mjs';
import { createAgentInbox } from '../lib/agent-inbox.mjs';

function fixture(db = new Database(':memory:')) {
  migrateCodexSessions(db);
  for (const [id, project, agent, box] of [
    ['a', 'p', 'alpha', 'box'], ['b', 'p', 'beta', 'box'], ['b-chat', 'p', 'beta', 'box'], ['c', 'p', 'gamma', 'box'],
    ['same-agent', 'p', 'alpha', 'box'], ['other-box', 'p', 'gamma', 'other'],
    ['local', 'p', 'delta', null], ['other-project', 'q', 'epsilon', 'box'],
  ]) db.prepare(`INSERT INTO codex_session
    (id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id,chat_request_id)
    VALUES (?,?,?,'owner','ready','now','now',?,?)`).run(id, project, agent, box, ['same-agent','b-chat'].includes(id) ? id : null);
  return { db, inbox: createAgentInbox(db) };
}
const message = (requestId, toSessionId = 'b') => ({
  projectId: 'p', fromSessionId: 'a', toSessionId, text: `Message ${requestId}`, requestId,
});
const code = expected => error => error.code === expected && Number.isInteger(error.status);

test('messages retain sequence order; delivery retries until acknowledgement', () => {
  const {db, inbox} = fixture();
  try {
    const first = inbox.send(message('one'));
    const second = inbox.send(message('two'));
    assert.equal(first.status, 'queued');
    assert(first.sequence < second.sequence);
    assert.deepEqual(inbox.pending({projectId: 'p', toSessionId: 'b'}).map(row => row.id), [first.id, second.id]);
    assert.deepEqual(inbox.pending({projectId: 'p', toSessionId: 'b', afterSequence: first.sequence}).map(row => row.id), [second.id]);
    assert.deepEqual(inbox.pending({projectId: 'p', toSessionId: 'b', limit: 1}).map(row => row.id), [first.id]);
    const delivered = inbox.markDelivered({projectId: 'p', toSessionId: 'b', messageId: first.id});
    assert.equal(delivered.status, 'delivered');
    assert(delivered.deliveredAt);
    assert.equal(inbox.markDelivered({projectId: 'p', toSessionId: 'b', messageId: first.id}).deliveredAt, delivered.deliveredAt);
    assert.deepEqual(inbox.pending({projectId: 'p', toSessionId: 'b'}).map(row => row.id), [first.id, second.id]);
    const acked = inbox.markAcknowledged({projectId: 'p', toSessionId: 'b', messageId: first.id});
    assert.equal(acked.status, 'acknowledged');
    assert(acked.acknowledgedAt);
    assert.equal(inbox.markDelivered({projectId: 'p', toSessionId: 'b', messageId: first.id}).status, 'acknowledged');
    assert.equal(inbox.markAcknowledged({projectId: 'p', toSessionId: 'b', messageId: first.id}).acknowledgedAt, acked.acknowledgedAt);
    assert.deepEqual(inbox.pending({projectId: 'p', toSessionId: 'b'}).map(row => row.id), [second.id]);
  } finally { db.close(); }
});

test('request ID retries return the same message and changed payload conflicts', () => {
  const {db, inbox} = fixture();
  try {
    const sent = inbox.send(message('retry'));
    assert.deepEqual(inbox.send(message('retry')), sent);
    assert.throws(() => inbox.send({...message('retry'), text: 'changed'}), code('request_conflict'));
    assert.throws(() => inbox.send(message('retry', 'same-agent')), code('request_conflict'));
    assert.throws(() => inbox.send({...message('retry'), projectId: 'q'}), code('request_conflict'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_inbox_message').get().n, 1);
    assert.throws(() => inbox.send({...message('long'), text: 'x'.repeat(16_385)}), code('invalid_inbox_text'));
  } finally { db.close(); }
});

test('box broadcast queues one session per other agent and freezes recipients across retries', () => {
  const {db, inbox} = fixture();
  try {
    const input = {projectId:'p',fromSessionId:'a',text:'Coordinate ports',requestId:randomUUID()};
    const first = inbox.broadcast(input);
    assert.deepEqual(first.map(row => row.toSessionId).sort(), ['b','c']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_inbox_message').get().n, 2);
    db.prepare(`INSERT INTO codex_session
      (id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id)
      VALUES ('new-agent','p','new','owner','ready','later','later','box')`).run();
    assert.deepEqual(inbox.broadcast(input).map(row => row.id), first.map(row => row.id));
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_inbox_message').get().n, 2);
    assert.throws(() => inbox.broadcast({...input,text:'Different'}), code('request_conflict'));
    assert.throws(() => inbox.broadcast({...input,requestId:'bad'}), code('invalid_inbox_request'));
    assert.throws(() => inbox.broadcast({...input,fromSessionId:'other-box',requestId:randomUUID()}), code('no_recipients'));
  } finally { db.close(); }
});

test('pending delivery survives a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-inbox-'));
  const filename = join(directory, 'inbox.sqlite');
  try {
    const first = fixture(new Database(filename));
    const sent = first.inbox.send(message('restart'));
    first.inbox.markDelivered({projectId: 'p', toSessionId: 'b', messageId: sent.id});
    first.db.close();
    const db = new Database(filename);
    const inbox = createAgentInbox(db);
    assert.equal(inbox.pending({projectId: 'p', toSessionId: 'b'})[0].id, sent.id);
    assert.equal(inbox.send(message('restart')).id, sent.id);
    inbox.markAcknowledged({projectId: 'p', toSessionId: 'b', messageId: sent.id});
    db.close();
    const reopened = new Database(filename);
    assert.deepEqual(createAgentInbox(reopened).pending({projectId: 'p', toSessionId: 'b'}), []);
    reopened.close();
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('project and recipient boundaries deny reads and state changes', () => {
  const {db, inbox} = fixture();
  try {
    const sent = inbox.send(message('scoped'));
    assert.throws(() => inbox.send(message('cross', 'other-project')), code('project_mismatch'));
    assert.throws(() => inbox.pending({projectId: 'q', toSessionId: 'b'}), code('project_mismatch'));
    assert.equal(inbox.get({projectId: 'q', messageId: sent.id}), null);
    assert.deepEqual(inbox.pending({projectId: 'p', toSessionId: 'a'}), []);
    assert.throws(() => inbox.markDelivered({projectId: 'p', toSessionId: 'a', messageId: sent.id}), code('wrong_recipient'));
    assert.throws(() => inbox.markAcknowledged({projectId: 'p', toSessionId: 'a', messageId: sent.id}), code('wrong_recipient'));
    assert.equal(inbox.get({projectId: 'p', messageId: sent.id}).status, 'queued');
  } finally { db.close(); }
});

test('conversations must be distinct and share a non-null run box', () => {
  const {db, inbox} = fixture();
  try {
    assert.throws(() => inbox.send(message('self', 'a')), code('same_session'));
    assert.equal(inbox.send(message('same-agent', 'same-agent')).toSessionId,'same-agent');
    assert.throws(() => inbox.send(message('other-box', 'other-box')), code('run_box_mismatch'));
    assert.throws(() => inbox.send(message('local', 'local')), code('run_box_mismatch'));
    assert.throws(() => inbox.send(message('missing', 'missing')), code('session_not_found'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_inbox_message').get().n, 1);
  } finally { db.close(); }
});

test('conversation broadcast reaches same-agent independent chats and freezes its audience', () => {
 const {db,inbox}=fixture();
 try {
  const input={projectId:'p',fromSessionId:'a',requestId:randomUUID(),text:'Please coordinate',audience:'conversations',actor:{id:'human',name:'Alex'}};
  const first=inbox.broadcast(input);
  assert.deepEqual(first.map(row=>row.toSessionId).sort(),['b-chat','same-agent']);
  assert(first.every(row=>row.actorId==='human'&&row.actorName==='Alex'));
  db.prepare("UPDATE codex_session SET status='stopped' WHERE id='b-chat'").run();
  assert.deepEqual(inbox.broadcast(input).map(row=>row.id),first.map(row=>row.id));
  assert.throws(()=>inbox.broadcast({...input,audience:'agents'}),code('request_conflict'));
  assert.throws(()=>inbox.broadcast({...input,requestId:randomUUID(),audience:'everyone'}),code('invalid_inbox_request'));
  const next=inbox.broadcast({...input,requestId:randomUUID()});
  assert.deepEqual(next.map(row=>row.toSessionId),['same-agent']);
 } finally {db.close();}
});

test('durable history includes acknowledged incoming and outgoing messages with safe cursors', () => {
 const {db,inbox}=fixture();
 try {
  const one=inbox.send({...message('history-one'),actor:{id:'human',name:'Alex'}});
  const two=inbox.send({...message('history-two'),fromSessionId:'b',toSessionId:'a'});
  const three=inbox.send(message('history-three'));
  inbox.markAcknowledged({projectId:'p',toSessionId:'b',messageId:one.id});
  const newest=inbox.history({projectId:'p',sessionId:'a',limit:2});
  assert.deepEqual(newest.messages.map(row=>[row.id,row.direction]),[[two.id,'incoming'],[three.id,'outgoing']]);
  assert.equal(newest.nextBeforeSequence,two.sequence);
  const older=inbox.history({projectId:'p',sessionId:'a',beforeSequence:newest.nextBeforeSequence,limit:2});
  assert.equal(older.messages[0].status,'acknowledged');assert.equal(older.messages[0].actorName,'Alex');
  assert.equal(older.nextBeforeSequence,null);
  assert.deepEqual(createAgentInbox(db).history({projectId:'p',sessionId:'a',limit:2}),newest);
  assert.throws(()=>inbox.history({projectId:'q',sessionId:'a'}),code('project_mismatch'));
  for(const value of [0,-1,1.5,NaN,Infinity])assert.throws(()=>inbox.history({projectId:'p',sessionId:'a',beforeSequence:value}),code('invalid_inbox_request'));
  assert.throws(()=>inbox.history({projectId:'p',sessionId:'a',limit:101}),code('invalid_inbox_request'));
 } finally {db.close();}
});

test('inbox persistence redacts credentials while original hashes protect retries', () => {
 const {db,inbox}=fixture();
 try {
  const input={...message('secret'),text:'TOKEN=first-secret',actor:{id:'human',name:'Alex'}};
  assert.throws(()=>inbox.send({...input,text:'x'.repeat(15001)}),code('invalid_inbox_text'));
  const sent=inbox.send(input);
  assert.equal(sent.text,'TOKEN=[redacted]');assert.equal(inbox.send(input).id,sent.id);
  assert.throws(()=>inbox.send({...input,text:'TOKEN=second-secret'}),code('request_conflict'));
  assert.throws(()=>inbox.send({...input,actor:{id:'someone-else',name:'Blair'}}),code('request_conflict'));
  const broadcast={projectId:'p',fromSessionId:'a',requestId:randomUUID(),text:'--password broadcast-secret',actor:input.actor};
  assert(inbox.broadcast(broadcast).every(row=>row.text==='--password [redacted]'));
  assert.throws(()=>inbox.broadcast({...broadcast,text:'--password other-secret'}),code('request_conflict'));
  const persisted=JSON.stringify([db.prepare('SELECT * FROM agent_inbox_message').all(),db.prepare('SELECT * FROM agent_inbox_broadcast').all()]);
  for(const secret of ['first-secret','second-secret','broadcast-secret','other-secret'])assert(!persisted.includes(secret));
  // Simulate rows from the old schema, whose text hashes and attribution were absent.
  db.prepare('UPDATE agent_inbox_message SET text=?,text_hash=NULL,actor_id=NULL,actor_name=NULL WHERE id=?').run('TOKEN=legacy-secret',sent.id);
  createAgentInbox(db);
  assert.equal(inbox.get({projectId:'p',messageId:sent.id}).text,'TOKEN=[redacted]');
  assert.equal(inbox.send({...input,text:'TOKEN=legacy-secret',actor:input.actor}).id,sent.id);
 } finally {db.close();}
});
