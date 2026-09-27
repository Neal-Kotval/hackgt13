import { randomUUID } from 'node:crypto';

export class AgentInboxError extends Error {
  constructor(message, status = 400, code = 'invalid_inbox_request') {
    super(message);
    this.name = 'AgentInboxError';
    this.status = status;
    this.code = code;
  }
}

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
  acknowledgedAt: row.acknowledged_at,
});

/** A durable transport inbox. Delivery and acknowledgement do not attest to model execution. */
export function createAgentInbox(db) {
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
    WHERE status <> 'acknowledged';`);

  const byId = db.prepare('SELECT * FROM agent_inbox_message WHERE project_id=? AND id=?');
  const byRequest = db.prepare('SELECT * FROM agent_inbox_message WHERE from_session_id=? AND request_id=?');
  const session = db.prepare('SELECT id,project_id,agent_id,run_box_id FROM codex_session WHERE id=?');

  const send = db.transaction(({projectId, fromSessionId, toSessionId, text, requestId}) => {
    requiredId(projectId, 'projectId');
    requiredId(fromSessionId, 'fromSessionId');
    requiredId(toSessionId, 'toSessionId');
    requiredId(requestId, 'requestId');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 16_384)
      fail('Message text must contain 1 to 16384 UTF-8 bytes.', 400, 'invalid_inbox_text');

    // A retry must match every field, including the recipient and project. The
    // persisted row is returned even if it has since been delivered or acked.
    const prior = byRequest.get(fromSessionId, requestId);
    if (prior) {
      if (prior.project_id !== projectId || prior.to_session_id !== toSessionId || prior.text !== text)
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
    if (source.agent_id === target.agent_id)
      fail('Recipient must be a different agent.', 403, 'same_agent');

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO agent_inbox_message
      (id,project_id,from_session_id,to_session_id,request_id,text,status,created_at)
      VALUES (?,?,?,?,?,?,'queued',?)`).run(id, projectId, fromSessionId, toSessionId, requestId, text, createdAt);
    return dto(byId.get(projectId, id));
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
    pending,
    markDelivered: args => transition(args, 'delivered'),
    markAcknowledged: args => transition(args, 'acknowledged'),
    get({projectId, messageId}) {
      requiredId(projectId, 'projectId');
      requiredId(messageId, 'messageId');
      return dto(byId.get(projectId, messageId)) ?? null;
    },
  };
}
