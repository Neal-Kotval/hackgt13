import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

export class CodexSessionError extends Error {
  constructor(message, status = 409, code = undefined) { super(message); this.status = status; this.code = code; }
}
export function migrateCodexSessions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS codex_session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    created_by TEXT NOT NULL, status TEXT NOT NULL, thread_id TEXT,
    active_turn_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '', UNIQUE(project_id, agent_id));
    CREATE TABLE IF NOT EXISTS codex_session_event (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES codex_session(id),
      event_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT, UNIQUE(session_id,event_id));
    CREATE TABLE IF NOT EXISTS codex_turn_request (
      session_id TEXT NOT NULL REFERENCES codex_session(id), request_id TEXT NOT NULL,
      text_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown', PRIMARY KEY(session_id,request_id));`);
  if(!db.prepare('PRAGMA table_info(codex_turn_request)').all().some(c=>c.name==='status'))db.exec("ALTER TABLE codex_turn_request ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'");
  const columns=db.prepare('PRAGMA table_info(codex_session)').all();
  if(!columns.some(c=>c.name==='context'))db.exec("ALTER TABLE codex_session ADD COLUMN context TEXT NOT NULL DEFAULT ''");
  const eventColumns=db.prepare('PRAGMA table_info(codex_session_event)').all();
  if(!eventColumns.some(c=>c.name==='actor_id'))db.exec('ALTER TABLE codex_session_event ADD COLUMN actor_id TEXT; ALTER TABLE codex_session_event ADD COLUMN actor_name TEXT;');
}
const now = () => new Date().toISOString();
function dto(row) {
  if (!row) return null;
  return { id:row.id, projectId:row.project_id, agentId:row.agent_id, createdBy:row.created_by,
    provider:'docker-local', status:row.status, threadId:row.thread_id, activeTurnId:row.active_turn_id,
    error:row.error, createdAt:row.created_at, updatedAt:row.updated_at };
}
export function createCodexSessionService({ db, runtimeFactory, stopFactory, dataDir, apiKey = '', model, maxActive = 4 }) {
  migrateCodexSessions(db);
  const runtimes = new Map(), locks = new Map();
  const installId = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0,16);
  // A server restart loses the stdio connection. Never claim the old turn is running.
  db.prepare("UPDATE codex_session SET status='error',active_turn_id=NULL,error='Server connection ended. Reconnect to recover the saved Codex thread.' WHERE status IN ('ready','running','initializing','auth_required')").run();
  const get = id => dto(db.prepare('SELECT * FROM codex_session WHERE id=?').get(id));
  const requireSession = id => { const session=get(id); if(!session) throw new CodexSessionError('Codex session not found',404); return session; };
  function patch(id, fields) {
    const names = {status:'status',threadId:'thread_id',activeTurnId:'active_turn_id',error:'error'};
    const entries=Object.entries(fields).filter(([key])=>names[key]);
    db.prepare(`UPDATE codex_session SET ${entries.map(([key])=>`${names[key]}=?`).join(',')},updated_at=? WHERE id=?`).run(...entries.map(([,value])=>value),now(),id);
    return get(id);
  }
  // Only public item text is persisted; never retain raw protocol/account responses.
  function safeText(text) {
    let value=String(text??'');
    if(apiKey) value=value.split(apiKey).join('[redacted]');
    return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g,'[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted]').replace(/((?:access_token|refresh_token|id_token|api_key|OPENAI_API_KEY)[\"'\s:=]+)[^\s\"',}]+/gi,'$1[redacted]').slice(-32768);
  }
  function event(id,eventId,kind,text,append=false,actor={}) {
    if(append){ const old=db.prepare('SELECT text FROM codex_session_event WHERE session_id=? AND event_id=?').get(id,eventId); text=(old?.text||'')+text; }
    const stamp=now();
    db.prepare(`INSERT INTO codex_session_event(session_id,event_id,kind,text,created_at,updated_at,actor_id,actor_name) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,event_id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at`).run(id,eventId,kind,safeText(text),stamp,stamp,actor.id||null,actor.name||null);
    db.prepare('DELETE FROM codex_session_event WHERE session_id=? AND sequence NOT IN (SELECT sequence FROM codex_session_event WHERE session_id=? ORDER BY sequence DESC LIMIT 300)').run(id,id);
  }
  function snapshot(id) {
    return {session:requireSession(id),events:db.prepare('SELECT event_id AS id,kind,text,created_at AS createdAt,updated_at AS updatedAt,actor_id AS actorId,actor_name AS actorName FROM codex_session_event WHERE session_id=? ORDER BY sequence').all(id)};
  }
  function fail(id,message='Codex connection failed. Check Docker and reconnect.') {
    patch(id,{status:'error',activeTurnId:null,error:message});
    event(id,randomUUID(),'error',message);
  }
  async function serial(id,fn) {
    const previous=locks.get(id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(fn); locks.set(id,task);
    try{return await task;}finally{if(locks.get(id)===task)locks.delete(id);}
  }
  function item(id,value) {
    if(!value?.id)return;
    if(value.type==='agentMessage')event(id,value.id,'assistant',value.text||'');
    if(value.type==='commandExecution')event(id,value.id,'command',`${value.command||'Command'}\n${value.status||''}${value.exitCode!==null&&value.exitCode!==undefined?` · exit ${value.exitCode}`:''}\n${value.aggregatedOutput||''}`);
    if(value.type==='fileChange')event(id,value.id,'command',`File changes · ${value.status||''}\n${(value.changes||[]).map(x=>x.path).join('\n')}`);
  }
  async function ready(id,runtime) {
    const current=requireSession(id);
    const account=await runtime.request('account/read',{refreshToken:false});
    if(!account.account){patch(id,{status:'auth_required',error:null});return;}
    const context=db.prepare('SELECT context FROM codex_session WHERE id=?').get(id).context;
    const options={developerInstructions:context||undefined,cwd:'/home/node/workspace',approvalPolicy:'never',sandbox:'danger-full-access',...(model?{model}:{})};
    let result;
    try {result=await runtime.request(current.threadId?'thread/resume':'thread/start',current.threadId?{threadId:current.threadId,...options}:options);}
    catch(error) {
      // Codex does not persist an empty thread until its first turn. There is no
      // conversation to lose only when no turn has ever been submitted.
      if(!current.threadId || db.prepare('SELECT count(*) AS n FROM codex_turn_request WHERE session_id=?').get(id).n)throw error;
      result=await runtime.request('thread/start',options);
    }
    if(!result.thread?.id)throw new Error('Missing thread');
    for(const turn of result.thread.turns||[]) for(const entry of turn.items||[])item(id,entry);
    patch(id,{status:'ready',threadId:result.thread.id,activeTurnId:null,error:null});
    event(id,randomUUID(),'status','Codex is ready in the local Docker workspace.');
  }
  function notify(id,message) {
    const {method,params:p={}}=message;
    if(method==='account/login/completed') {
      if(p.success && p.loginId){const runtime=runtimes.get(id);if(runtime)void serial(id,()=>ready(id,runtime)).catch(()=>fail(id));}
      else if(!p.success) patch(id,{status:'auth_required',error:'Codex sign-in did not complete. Try signing in again.'});
      return;
    }
    if(method==='turn/started')patch(id,{status:'running',activeTurnId:p.turn?.id||null,error:null});
    if(method==='item/started'||method==='item/completed')item(id,p.item);
    if(method==='item/agentMessage/delta')event(id,p.itemId,'assistant',p.delta||'',true);
    if(method==='item/commandExecution/outputDelta')event(id,p.itemId,'command',p.delta||'',true);
    if(method==='turn/completed') {
      const failed=p.turn?.status==='failed';
      patch(id,{status:failed?'error':'ready',activeTurnId:null,error:failed?'Codex turn failed. Reconnect or check your Codex account.':null});
      event(id,`turn-${p.turn?.id||randomUUID()}`,'status',`Turn ${p.turn?.status||'completed'}`);
    }
    if(method==='error')event(id,randomUUID(),'error','Codex reported an execution error. Check your account and retry or reconnect.');
  }
  async function connect(id) {
    patch(id,{status:'initializing',error:null,activeTurnId:null});
    const old=runtimes.get(id);runtimes.delete(id);old?.close();
    let runtime;
    try {
      runtime=await runtimeFactory({sessionId:id,installId,onNotification:(method,params)=>{if(runtimes.get(id)===runtime)notify(id,{method,params});},onExit:()=>{if(runtimes.get(id)===runtime){runtimes.delete(id);fail(id);}}});
      runtimes.set(id,runtime);
      if(apiKey)await runtime.request('account/login/start',{type:'apiKey',apiKey});
      await ready(id,runtime);
    }catch{runtimes.delete(id);runtime?.close();fail(id);}
  }
  return {
    get:requireSession,snapshot,
    list:projectId=>db.prepare('SELECT * FROM codex_session WHERE project_id=? ORDER BY created_at').all(projectId).map(dto),
    initialize({projectId,agentId,createdBy,projectName='',repoUrl=''}) {
      const existing=db.prepare('SELECT * FROM codex_session WHERE project_id=? AND agent_id=?').get(projectId,agentId);
      if(existing)return dto(existing);
      if(db.prepare("SELECT count(*) AS n FROM codex_session WHERE status <> 'stopped'").get().n>=maxActive)throw new CodexSessionError('Stop an existing Codex box before starting another.',429);
      const id=randomUUID(),stamp=now();
      db.prepare('INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?,?)').run(id,projectId,agentId,createdBy,'initializing',stamp,stamp,`You are the Codex agent for AgentCloud project ${projectName}. Its saved repository URL is ${repoUrl||'not configured'}. Your persistent workspace is /home/node/workspace in a local Docker CPU box. The workspace starts empty; the repository has not been cloned automatically. Do not claim AWS or GPU execution. Follow the human's instructions from the desktop app.`);
      event(id,randomUUID(),'status','Starting a local Docker CPU box for Codex.');
      void serial(id,()=>connect(id)); return get(id);
    },
    async action(id,input) {
      requireSession(id);
      return serial(id,async()=>{
        let session=get(id),runtime=runtimes.get(id);
        if(input.action==='resume') {if(db.prepare("SELECT count(*) AS n FROM codex_session WHERE id<>? AND status <> 'stopped'").get(id).n>=maxActive)throw new CodexSessionError('Stop another Codex box first.',429);if(session.status==='running')throw new CodexSessionError('Interrupt the active turn before reconnecting.');await connect(id);return {session:get(id)};}
        if(input.action==='stop') {
          // Reconnect only to address the existing deterministic container after server restart.
          runtimes.delete(id);
          try{if(runtime)await runtime.stop();else await stopFactory({sessionId:id,installId});}catch{runtime?.close();fail(id,'Docker stop failed. Reconnect and try again.');throw new CodexSessionError('Docker stop failed.',502);}
          patch(id,{status:'stopped',activeTurnId:null,error:null});event(id,randomUUID(),'status','Docker box stopped. Workspace and Codex history retained.');return {session:get(id)};
        }
        if(!runtime)throw new CodexSessionError('Reconnect this Codex session first.');
        if(input.action==='login') {
          if(session.status!=='auth_required')throw new CodexSessionError('This session does not need sign-in.');
          const login=await runtime.request('account/login/start',{type:'chatgptDeviceCode'});
          if(login.type!=='chatgptDeviceCode'||!/^https:\/\/auth\.openai\.com\//.test(login.verificationUrl)||typeof login.userCode!=='string')throw new CodexSessionError('Codex device sign-in unavailable.',502);
          return {session:get(id),login:{verificationUrl:login.verificationUrl,userCode:login.userCode}};
        }
        if(input.action==='interrupt') {
          if(session.activeTurnId)await runtime.request('turn/interrupt',{threadId:session.threadId,turnId:session.activeTurnId});
          return {session:get(id)}; // Only turn/completed confirms it stopped.
        }
        if(input.action!=='message')throw new CodexSessionError('Unknown Codex action',400);
        const text=typeof input.text==='string'?input.text.trim():'';
        if(!text||text.length>16000||typeof input.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(input.requestId))throw new CodexSessionError('A message and unique request ID are required.',400);
        const hash=createHash('sha256').update(text).digest('hex');
        const prior=db.prepare('SELECT text_hash,status FROM codex_turn_request WHERE session_id=? AND request_id=?').get(id,input.requestId);
        if(prior){if(prior.text_hash!==hash)throw new CodexSessionError('Request ID already used for another message.');if(prior.status!=='accepted')throw new CodexSessionError('Previous send could not be confirmed. Inspect the recovered history before explicitly sending a new turn.',409,'ambiguous_turn');return {session:get(id)};}
        if(session.status!=='ready'||!session.threadId)throw new CodexSessionError('Codex must be ready before sending a message.');
        db.prepare('INSERT INTO codex_turn_request(session_id,request_id,text_hash) VALUES(?,?,?)').run(id,input.requestId,hash);
        event(id,`user-${input.requestId}`,'user',text,false,input.actor);
        patch(id,{status:'running',error:null});
        try {
          await runtime.request('turn/start',{threadId:session.threadId,input:[{type:'text',text}],approvalPolicy:'never',sandboxPolicy:{type:'externalSandbox',networkAccess:'enabled'}});
          db.prepare("UPDATE codex_turn_request SET status='accepted' WHERE session_id=? AND request_id=?").run(id,input.requestId);
        }catch{
          // Never replay an ambiguous start automatically: it may already have run.
          fail(id,'Could not confirm the turn. Reconnect to inspect saved history before sending again.');
          throw new CodexSessionError('Turn start could not be confirmed. Reconnect and inspect history before sending a new turn.',502,'ambiguous_turn');
        }
        return {session:get(id)};
      });
    },
    close(){const active=[...runtimes.values()];runtimes.clear();for(const runtime of active)runtime.close();},
  };
}
