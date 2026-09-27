import { redactExecutionText } from './codex-execution-details.mjs';
import { randomUUID, createHash } from 'node:crypto';

export class AgentInboxError extends Error {
  constructor(message, status = 400, code = 'invalid_inbox_request') {
    super(message);
    this.name = 'AgentInboxError';
    this.status = status;
    this.code = code;
  }
}

const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (message, status, code) => { throw new AgentInboxError(message, status, code); };
const requiredId = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    fail(`${name} is required.`, 400, 'invalid_inbox_request');
  return value;
};
const dto = row => row && ({
  id: row.id, sequence: row.sequence, projectId: row.project_id,
  fromSessionId: row.from_session_id, toSessionId: row.to_session_id,
  text: row.text, requestId: row.request_id, status: row.status,
  createdAt: row.created_at, deliveredAt: row.delivered_at,
  acknowledgedAt: row.acknowledged_at, actorId: row.actor_id ?? null, actorName: row.actor_name ?? null,
});

/** A durable transport inbox. Delivery and acknowledgement do not attest to model execution. */
export function createAgentInbox(db, {redactText = redactExecutionText} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_inbox_message (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    from_session_id TEXT NOT NULL,
    to_session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','delivered','acknowledged')),
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    acknowledged_at TEXT,
    UNIQUE(from_session_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS agent_inbox_pending
    ON agent_inbox_message(project_id, to_session_id, sequence)
    WHERE status <> 'acknowledged';
  CREATE INDEX IF NOT EXISTS agent_inbox_outgoing_history ON agent_inbox_message(project_id,from_session_id,sequence);
  CREATE INDEX IF NOT EXISTS agent_inbox_incoming_history ON agent_inbox_message(project_id,to_session_id,sequence);
  CREATE TABLE IF NOT EXISTS agent_inbox_broadcast (
    from_session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_box_id TEXT NOT NULL,
    text TEXT NOT NULL,
    recipient_ids TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_session_id, request_id)
  );`);

  // Existing inbox text predates structured redaction. Hash its original request
  // first, then sanitize history once; retries still compare original payloads.
  db.transaction(() => {
    for (const table of ['agent_inbox_message','agent_inbox_broadcast']) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const column of ['actor_id','actor_name','text_hash']) if (!columns.has(column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      if (table === 'agent_inbox_broadcast' && !columns.has('audience'))
        db.exec("ALTER TABLE agent_inbox_broadcast ADD COLUMN audience TEXT NOT NULL DEFAULT 'agents'");
      db.pragma('secure_delete = ON');
      for (const row of db.prepare(`SELECT rowid AS migration_rowid,text FROM ${table} WHERE text_hash IS NULL`).all())
        db.prepare(`UPDATE ${table} SET text_hash=?,text=? WHERE rowid=?`).run(hash(row.text),redactText(row.text),row.migration_rowid);
    }
  })();
  const safeMessageText = text => {
    const clean=redactText(text);
    if(clean.length>15000)fail('Message is too long after redaction. Use at most 15000 characters.',400,'invalid_inbox_text');
    return clean;
  };
  const actorFields = actor => ({ id: typeof actor?.id === 'string' ? actor.id.slice(0,128) : null,
    name: typeof actor?.name === 'string' ? redactText(actor.name).slice(0,200) : null });
  const byId = db.prepare('SELECT * FROM agent_inbox_message WHERE project_id=? AND id=?');
  const byRequest = db.prepare('SELECT * FROM agent_inbox_message WHERE from_session_id=? AND request_id=?');
  const session = db.prepare('SELECT id,project_id,agent_id,run_box_id FROM codex_session WHERE id=?');

  const send = db.transaction(({projectId, fromSessionId, toSessionId, text, requestId, actor}) => {
    requiredId(projectId, 'projectId');
    requiredId(fromSessionId, 'fromSessionId');
    requiredId(toSessionId, 'toSessionId');
    requiredId(requestId, 'requestId');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 16_384)
      fail('Message text must contain 1 to 16384 UTF-8 bytes.', 400, 'invalid_inbox_text');

    // A retry must match every field, including the recipient and project. The
    // persisted row is returned even if it has since been delivered or acked.
    const attributed = actorFields(actor);
    const textHash = hash(text);
    const safeText = safeMessageText(text);
    const prior = byRequest.get(fromSessionId, requestId);
    if (prior) {
      if (prior.project_id !== projectId || prior.to_session_id !== toSessionId || prior.text_hash !== textHash || (prior.actor_id !== null && prior.actor_id !== attributed.id))
        fail('requestId was already used for a different message.', 409, 'request_conflict');
      return dto(prior);
    }

    const source = session.get(fromSessionId);
    const target = session.get(toSessionId);
    if (!source || !target) fail('Both agent sessions must exist.', 404, 'session_not_found');
    if (source.project_id !== projectId || target.project_id !== projectId)
      fail('Agent sessions must belong to this project.', 403, 'project_mismatch');
    if (!source.run_box_id || source.run_box_id !== target.run_box_id)
      fail('Agent sessions must share a run box.', 403, 'run_box_mismatch');
    if (source.id === target.id)
      fail('Recipient must be a different conversation.', 403, 'same_session');

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO agent_inbox_message
      (id,project_id,from_session_id,to_session_id,request_id,text,status,created_at,actor_id,actor_name,text_hash)
      VALUES (?,?,?,?,?,?,'queued',?,?,?,?)`).run(id, projectId, fromSessionId, toSessionId, requestId, safeText, createdAt,attributed.id,attributed.name,textHash);
    return dto(byId.get(projectId, id));
  });

  /** Freeze the selected audience so retries never reach new conversations. */
  const broadcast = db.transaction(({projectId, fromSessionId, text, requestId, actor, audience = 'agents'}) => {
    requiredId(projectId, 'projectId');
    requiredId(fromSessionId, 'fromSessionId');
    requiredId(requestId, 'requestId');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))
      fail('A unique broadcast request ID is required.', 400, 'invalid_inbox_request');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 16_384)
      fail('Message text must contain 1 to 16384 UTF-8 bytes.', 400, 'invalid_inbox_text');
    if (!['agents','conversations'].includes(audience))fail('Invalid broadcast audience.',400,'invalid_inbox_request');
    const attributed = actorFields(actor);
    const textHash = hash(text);
    const safeText = safeMessageText(text);
    const source = session.get(fromSessionId);
    if (!source || source.project_id !== projectId || !source.run_box_id)
      fail('Sending agent session must be on this project box.', 403, 'run_box_mismatch');
    const prior = db.prepare('SELECT * FROM agent_inbox_broadcast WHERE from_session_id=? AND request_id=?').get(fromSessionId, requestId);
    if (prior && (prior.project_id !== projectId || prior.run_box_id !== source.run_box_id || prior.text_hash !== textHash || (prior.actor_id !== null && prior.actor_id !== attributed.id) || prior.audience !== audience))
      fail('requestId was already used for a different broadcast.', 409, 'request_conflict');
    let recipients;
    if (prior) recipients = JSON.parse(prior.recipient_ids);
    else {
      const rows = audience === 'conversations' ? db.prepare(`SELECT id,agent_id FROM codex_session
        WHERE project_id=? AND run_box_id=? AND id<>? AND chat_request_id IS NOT NULL AND status<>'stopped'
        ORDER BY created_at,id`).all(projectId,source.run_box_id,fromSessionId) : db.prepare(`SELECT id,agent_id FROM codex_session
        WHERE project_id=? AND run_box_id=? AND agent_id<>? AND status<>'stopped'
        ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
          CASE WHEN chat_request_id IS NULL THEN 0 ELSE 1 END, created_at DESC`)
        .all(projectId, source.run_box_id, source.agent_id);
      const seen = new Set();
      recipients = rows.filter(row => {
        if (audience === 'conversations')return true;
        if (seen.has(row.agent_id)) return false;
        seen.add(row.agent_id);
        return true;
      }).map(row => row.id);
      if (!recipients.length) fail('No other eligible conversations are on this box.', 409, 'no_recipients');
      db.prepare(`INSERT INTO agent_inbox_broadcast
        (from_session_id,request_id,project_id,run_box_id,text,recipient_ids,created_at,actor_id,actor_name,text_hash,audience)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(fromSessionId,requestId,projectId,source.run_box_id,safeText,JSON.stringify(recipients),new Date().toISOString(),attributed.id,attributed.name,textHash,audience);
    }
    return recipients.map(toSessionId => send({projectId,fromSessionId,toSessionId,text,actor,
      requestId:`${requestId}:${toSessionId}`}));
  });

  function pending({projectId, toSessionId, afterSequence = 0, limit = 100}) {
    requiredId(projectId, 'projectId');
    requiredId(toSessionId, 'toSessionId');
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail('Invalid inbox cursor or limit.', 400, 'invalid_inbox_request');
    const target = session.get(toSessionId);
    if (!target) fail('Agent session does not exist.', 404, 'session_not_found');
    if (target.project_id !== projectId) fail('Agent session is outside this project.', 403, 'project_mismatch');
    return db.prepare(`SELECT * FROM agent_inbox_message
      WHERE project_id=? AND to_session_id=? AND sequence>? AND status<>'acknowledged'
      ORDER BY sequence LIMIT ?`).all(projectId, toSessionId, afterSequence, limit).map(dto);
  }

  function transition({projectId, toSessionId, messageId}, status) {
    requiredId(projectId, 'projectId');
    requiredId(toSessionId, 'toSessionId');
    requiredId(messageId, 'messageId');
    const row = byId.get(projectId, messageId);
    if (!row) fail('Inbox message does not exist.', 404, 'message_not_found');
    if (row.to_session_id !== toSessionId) fail('Message belongs to another recipient.', 403, 'wrong_recipient');
    if (status === 'delivered') {
      db.prepare(`UPDATE agent_inbox_message SET status='delivered', delivered_at=?
        WHERE project_id=? AND id=? AND status='queued'`).run(new Date().toISOString(), projectId, messageId);
    } else {
      db.prepare(`UPDATE agent_inbox_message SET status='acknowledged', acknowledged_at=?
        WHERE project_id=? AND id=? AND status<>'acknowledged'`).run(new Date().toISOString(), projectId, messageId);
    }
    return dto(byId.get(projectId, messageId));
  }

  return {
    send,
    broadcast,
    pending,
    history({projectId, sessionId, beforeSequence = Number.MAX_SAFE_INTEGER, limit = 50}) {
      requiredId(projectId,'projectId');requiredId(sessionId,'sessionId');
      if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail('Invalid history cursor or limit.',400,'invalid_inbox_request');
      const source=session.get(sessionId);
      if (!source)fail('Conversation does not exist.',404,'session_not_found');
      if (source.project_id !== projectId)fail('Conversation is outside this project.',403,'project_mismatch');
      const rows=db.prepare(`SELECT * FROM agent_inbox_message WHERE project_id=? AND
        (from_session_id=? OR to_session_id=?) AND sequence<? ORDER BY sequence DESC LIMIT ?`)
        .all(projectId,sessionId,sessionId,beforeSequence,limit+1);
      const page=rows.slice(0,limit);
      return {messages:page.reverse().map(row=>({...dto(row),direction:row.from_session_id===sessionId?'outgoing':'incoming'})),
        nextBeforeSequence:rows.length>limit?page[0].sequence:null};
    },
    markDelivered: args => transition(args, 'delivered'),
    markAcknowledged: args => transition(args, 'acknowledged'),
    get({projectId, messageId}) {
      requiredId(projectId, 'projectId');
      requiredId(messageId, 'messageId');
      return dto(byId.get(projectId, messageId)) ?? null;
    },
  };
}
