import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { CodexLoginError, loginMethod, parseBrowserLoginStart } from './codex-login.mjs';

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
  migrateSessionTarget(db);
  migrateChats(db);
  // Older versions saved command arguments and raw output. Remove that material
  // before a snapshot can read it, including on an existing installation.
  db.exec('CREATE TABLE IF NOT EXISTS codex_session_migration (name TEXT PRIMARY KEY)');
  db.transaction(()=>{
    const name='remove-raw-command-output-v1';
    if(db.prepare('SELECT name FROM codex_session_migration WHERE name=?').get(name))return;
    db.pragma('secure_delete = ON');
    db.prepare("UPDATE codex_session_event SET text='Command details removed from saved history.' WHERE kind='command'").run();
    db.prepare('INSERT INTO codex_session_migration(name) VALUES(?)').run(name);
  })();
}
// HAC-153: a session targets local Docker (run_box_id NULL) or one environment.
// The table-level UNIQUE(project_id, agent_id) is replaced by a unique index over
// (project_id, agent_id, run_box_id). SQLite cannot drop a table constraint, so
// the table is rebuilt once, preserving every row and its events.
function migrateSessionTarget(db) {
  const columns=db.prepare('PRAGMA table_info(codex_session)').all();
  if(!columns.some(c=>c.name==='run_box_id')) {
    if(db.inTransaction)throw new Error('Codex session target migration requires a top-level migration');
    const foreignKeys=db.pragma('foreign_keys',{simple:true});
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(()=>{
        db.exec(`CREATE TABLE codex_session_next (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
          created_by TEXT NOT NULL, status TEXT NOT NULL, thread_id TEXT,
          active_turn_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          context TEXT NOT NULL DEFAULT '', run_box_id TEXT);
          INSERT INTO codex_session_next(id,project_id,agent_id,created_by,status,thread_id,active_turn_id,error,created_at,updated_at,context,run_box_id)
            SELECT id,project_id,agent_id,created_by,status,thread_id,active_turn_id,error,created_at,updated_at,context,NULL FROM codex_session;
          DROP TABLE codex_session;
          ALTER TABLE codex_session_next RENAME TO codex_session;`);
        if(db.pragma('foreign_key_check').length)throw new Error('Codex session target migration violated foreign keys');
      })();
    } finally { db.pragma(`foreign_keys = ${foreignKeys?'ON':'OFF'}`); }
  }
  if(!db.prepare('PRAGMA table_info(codex_session)').all().some(c=>c.name==='chat_request_id'))
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS codex_session_target ON codex_session(project_id, agent_id, COALESCE(run_box_id, ''))");
}
// Existing rows remain the canonical setup session. New chats have independent
// request IDs, threads and events while sharing the environment's signed-in account.
function migrateChats(db) {
  db.transaction(()=>{
    const columns=db.prepare('PRAGMA table_info(codex_session)').all();
    if(!columns.some(c=>c.name==='chat_request_id'))db.exec('ALTER TABLE codex_session ADD COLUMN chat_request_id TEXT');
    if(!columns.some(c=>c.name==='title')) {
      db.exec('ALTER TABLE codex_session ADD COLUMN title TEXT');
      for(const row of db.prepare("SELECT id,(SELECT text FROM codex_session_event WHERE session_id=codex_session.id AND kind='user' ORDER BY sequence LIMIT 1) AS first_text FROM codex_session").all()) {
        if(row.first_text)db.prepare('UPDATE codex_session SET title=? WHERE id=?').run(chatTitle(row.first_text),row.id);
      }
    }
    db.exec(`DROP INDEX IF EXISTS codex_session_target;
      CREATE UNIQUE INDEX IF NOT EXISTS codex_session_setup_target ON codex_session(project_id,agent_id,COALESCE(run_box_id,'')) WHERE chat_request_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS codex_session_chat_request ON codex_session(created_by,chat_request_id) WHERE chat_request_id IS NOT NULL;`);
  })();
}
const chatTitle=text=>String(text).replace(/\s+/g,' ').trim().slice(0,80);
const now = () => new Date().toISOString();
const RUN_BOX_ID = /^[A-Za-z0-9-]{1,64}$/;
export const ENVIRONMENT_STOPPED = 'Environment stopped';
/**
 * @param {{ db: any, runtimeFactory: (options: any) => any, stopFactory?: any, dataDir: string, apiKey?: string,
 *   model?: string, maxActive?: number, maxRemote?: number, sweepMs?: number,
 *   targets?: { describe: (runBoxId: string) => any } | null,
 *   onStopRequested?: ((listener: (runBoxId: string) => void) => unknown) | null }} options
 */
export function createCodexSessionService({ db, runtimeFactory, stopFactory, dataDir, apiKey = '', model, maxActive = 4,
  maxRemote = 16, targets = null, sweepMs = 5_000, onStopRequested = null }) {
  migrateCodexSessions(db);
  // `targets.describe(runBoxId)` -> { runBoxId, projectId, provider, profileId, state, stopRequested,
  //   codexState, workspacePath, serverKeyInstalled } | null (lib/codex-targets.mjs).
  const describe = runBoxId => { try { return targets?.describe(runBoxId) ?? null; } catch { return null; } };
  function dto(row) {
    if (!row) return null;
    const target=row.run_box_id?describe(row.run_box_id):null;
    return { id:row.id, title:row.title||'New chat', isSetupSession:row.chat_request_id===null, projectId:row.project_id, agentId:row.agent_id, createdBy:row.created_by,
      provider:row.run_box_id?(target?.provider??null):'docker-local',
      target:row.run_box_id?{kind:'runBox',runBoxId:row.run_box_id,provider:target?.provider??null,profileId:target?.profileId??null,state:target?.state??null}:{kind:'local'},
      status:row.status, threadId:row.thread_id, activeTurnId:row.active_turn_id,
      error:row.error, createdAt:row.created_at, updatedAt:row.updated_at };
  }
  const runBoxOf = id => db.prepare('SELECT run_box_id FROM codex_session WHERE id=?').get(id)?.run_box_id ?? null;
  const runtimes = new Map(), locks = new Map();
  // HAC-161: the in-progress login per session (never persisted), and logins the owner cancelled.
  const pendingLogins = new Map(), cancelledLogins = new Set();
  const installId = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0,16);
  // A server restart loses the stdio connection. Never claim the old turn is running.
  db.prepare("UPDATE codex_session SET status='error',active_turn_id=NULL,error='Server connection ended. Reconnect to recover the saved Codex thread.' WHERE status IN ('ready','running','initializing','auth_required')").run();
  const get = id => dto(db.prepare('SELECT * FROM codex_session WHERE id=?').get(id));
  const requireSession = id => { const session=get(id); if(!session) throw new CodexSessionError('Codex session not found',404); return session; };
  function patch(id, fields) {
    const names = {status:'status',threadId:'thread_id',activeTurnId:'active_turn_id',error:'error'};
    // A login only lives while the session waits for sign-in on the same connection.
    if(fields.status!==undefined&&fields.status!=='auth_required')pendingLogins.delete(id);
    const entries=Object.entries(fields).filter(([key])=>names[key]);
    db.prepare(`UPDATE codex_session SET ${entries.map(([key])=>`${names[key]}=?`).join(',')},updated_at=? WHERE id=?`).run(...entries.map(([,value])=>value),now(),id);
    return get(id);
  }
  // Never retain raw protocol/account responses. Messages may still contain secrets.
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
  function fail(id,message=runBoxOf(id)?'Codex connection to the environment failed. Reconnect to continue.':'Codex connection failed. Check Docker and reconnect.') {
    patch(id,{status:'error',activeTurnId:null,error:message});
    event(id,randomUUID(),'error',message);
  }
  function executionStatus(value) {
    const statuses={inProgress:'running',completed:'completed',failed:'failed',declined:'declined'};
    return statuses[value]||'status unavailable';
  }
  function commandSummary(value) {
    const exit=Number.isInteger(value.exitCode)&&value.exitCode>=0&&value.exitCode<=255?` · exit ${value.exitCode}`:'';
    return `Command ${executionStatus(value.status)}${exit}. Output is not saved.`;
  }
  async function serial(id,fn) {
    const previous=locks.get(id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(fn); locks.set(id,task);
    try{return await task;}finally{if(locks.get(id)===task)locks.delete(id);}
  }
  function item(id,value) {
    if(!value?.id)return;
    if(value.type==='agentMessage')event(id,value.id,'assistant',value.text||'');
    if(value.type==='commandExecution')event(id,value.id,'command',commandSummary(value));
    if(value.type==='fileChange')event(id,value.id,'command',`File changes ${executionStatus(value.status)}. Paths are not saved.`);
  }
  async function ready(id,runtime) {
    const current=requireSession(id);
    const account=await runtime.request('account/read',{refreshToken:false});
    if(!account.account){patch(id,{status:'auth_required',error:null});return;}
    const {context,run_box_id:runBoxId}=db.prepare('SELECT context,run_box_id FROM codex_session WHERE id=?').get(id);
    const cwd=runBoxId?describe(runBoxId)?.workspacePath:'/home/node/workspace';
    if(!cwd)throw new Error('Missing workspace');
    const options={developerInstructions:context||undefined,cwd,approvalPolicy:'never',sandbox:'danger-full-access',...(model?{model}:{})};
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
    event(id,randomUUID(),'status',runBoxId?`Codex is ready in the environment workspace ${cwd}.`:'Codex is ready in the local Docker workspace.');
  }
  function notify(id,message) {
    const {method,params:p={}}=message;
    if(method==='account/login/completed') {
      if(p.loginId&&pendingLogins.get(id)===p.loginId)pendingLogins.delete(id);
      if(!p.success&&p.loginId&&cancelledLogins.delete(p.loginId)){patch(id,{status:'auth_required',error:null});return;}
      if(p.success && p.loginId){const runtime=runtimes.get(id);if(runtime)void serial(id,()=>ready(id,runtime)).catch(()=>fail(id));}
      else if(!p.success) patch(id,{status:'auth_required',error:'Codex sign-in did not complete. Try signing in again.'});
      return;
    }
    if(method==='turn/started')patch(id,{status:'running',activeTurnId:p.turn?.id||null,error:null});
    if(method==='item/started'||method==='item/completed')item(id,p.item);
    if(method==='item/agentMessage/delta')event(id,p.itemId,'assistant',p.delta||'',true);
    // Raw stdout/stderr can contain arbitrary credentials. Status comes from
    // item/started and item/completed; never save output deltas.
    if(method==='turn/completed') {
      const failed=p.turn?.status==='failed';
      patch(id,{status:failed?'error':'ready',activeTurnId:null,error:failed?'Codex turn failed. Reconnect or check your Codex account.':null});
      event(id,`turn-${p.turn?.id||randomUUID()}`,'status',`Turn ${p.turn?.status||'completed'}`);
    }
    if(method==='error')event(id,randomUUID(),'error','Codex reported an execution error. Check your account and retry or reconnect.');
  }
  async function connect(id) {
    patch(id,{status:'initializing',error:null,activeTurnId:null});
    const old=runtimes.get(id);runtimes.delete(id);old?.close();pendingLogins.delete(id);
    const runBoxId=runBoxOf(id);
    let runtime;
    try {
      runtime=await runtimeFactory({sessionId:id,installId,runBoxId,onNotification:(method,params)=>{if(runtimes.get(id)===runtime)notify(id,{method,params});},onExit:()=>{if(runtimes.get(id)===runtime){runtimes.delete(id);fail(id,stoppedTarget(runBoxId)?ENVIRONMENT_STOPPED:undefined);}}});
      runtimes.set(id,runtime);
      // The operator API key is for local Docker only; it is never sent to a remote environment.
      if(apiKey&&!runBoxId)await runtime.request('account/login/start',{type:'apiKey',apiKey});
      await ready(id,runtime);
    }catch(error){
      runtimes.delete(id);runtime?.close();
      // Only messages written by AgentCloud (transport errors) are shown; never protocol or ssh text.
      fail(id,typeof error?.publicMessage==='string'?error.publicMessage.slice(0,256):undefined);
    }
  }
  async function cancelLogin(id,runtime,loginId) {
    cancelledLogins.add(loginId);
    if(pendingLogins.get(id)===loginId)pendingLogins.delete(id);
    try{await runtime.request('account/login/cancel',{loginId});}
    catch{cancelledLogins.delete(loginId);throw new CodexSessionError('Codex could not cancel the sign-in. Reconnect to reset it.',502);}
    // Codex may report the cancelled attempt as a failed completion; that is not an error to show.
    if(cancelledLogins.size>64)cancelledLogins.delete(cancelledLogins.values().next().value);
  }
  function stoppedTarget(runBoxId) {
    if(!runBoxId)return false;
    const target=describe(runBoxId);
    return !target||target.state!=='ready'||target.stopRequested;
  }
  // Closes every session on an environment that is stopping or gone and records why.
  function closeRunBoxSessions(runBoxId,message=ENVIRONMENT_STOPPED) {
    const rows=db.prepare("SELECT id,status FROM codex_session WHERE run_box_id=?").all(runBoxId);
    for(const row of rows) {
      const runtime=runtimes.get(row.id);runtimes.delete(row.id);runtime?.close();
      if(row.status==='stopped'||(row.status==='error'&&!runtime&&db.prepare('SELECT error FROM codex_session WHERE id=?').get(row.id).error===message))continue;
      patch(row.id,{status:'error',activeTurnId:null,error:message});
      event(row.id,randomUUID(),'status',`${message}. The Codex session on it was closed.`);
    }
    return rows.length;
  }
  function sweep() {
    const rows=db.prepare("SELECT DISTINCT run_box_id FROM codex_session WHERE run_box_id IS NOT NULL AND status <> 'stopped'").all();
    for(const {run_box_id:runBoxId} of rows) if(stoppedTarget(runBoxId))closeRunBoxSessions(runBoxId);
  }
  const sweeper=sweepMs>0?setInterval(()=>{try{sweep();}catch{/* Retried next interval. */}},sweepMs):null;
  sweeper?.unref?.();
  const unsubscribe=typeof onStopRequested==='function'?onStopRequested(runBoxId=>{try{closeRunBoxSessions(runBoxId);}catch{/* The sweep retries. */}}):null;
  function validateTarget(projectId,runBoxId) {
    if(typeof runBoxId!=='string'||!RUN_BOX_ID.test(runBoxId))throw new CodexSessionError('Invalid environment.',400);
    const target=describe(runBoxId);
    if(!target||target.projectId!==projectId)throw new CodexSessionError('Environment not found in this project.',409);
    if(target.state!=='ready'||target.stopRequested)throw new CodexSessionError('The environment must be ready to run Codex.',409);
    if(target.codexState!=='ready')throw new CodexSessionError('Codex is not ready on this environment.',409);
    if(!target.workspacePath)throw new CodexSessionError('The environment has no recorded workspace.',409);
    if(!target.serverKeyInstalled)throw new CodexSessionError('Create a new environment to use Codex on it.',409);
    return target;
  }
  return {
    validateEnvironment: validateTarget,
    get:id=>{sweep();return requireSession(id);},
    snapshot:id=>{sweep();return snapshot(id);},
    list:projectId=>{sweep();return db.prepare('SELECT * FROM codex_session WHERE project_id=? ORDER BY created_at').all(projectId).map(dto);},
    initialize({projectId,agentId,createdBy,projectName='',repoUrl='',runBoxId=/** @type {string|null} */ (null),newChat=false,requestId=/** @type {string|undefined} */ (undefined)}) {
      runBoxId=runBoxId??null;
      if(newChat) {
        if(!runBoxId)throw new CodexSessionError('New chats require an environment.',400);
        if(typeof requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))throw new CodexSessionError('A unique chat request ID is required.',400);
        const prior=db.prepare('SELECT * FROM codex_session WHERE created_by=? AND chat_request_id=?').get(createdBy,requestId);
        if(prior) {
          if(prior.project_id!==projectId||prior.agent_id!==agentId||prior.run_box_id!==runBoxId)throw new CodexSessionError('Chat request ID already used for another environment or agent.');
          return dto(prior);
        }
      }
      const target=runBoxId===null?null:validateTarget(projectId,runBoxId);
      const existing=db.prepare('SELECT * FROM codex_session WHERE project_id=? AND agent_id=? AND run_box_id IS ? AND chat_request_id IS NULL').get(projectId,agentId,runBoxId);
      if(!newChat&&existing)return dto(existing);
      if(newChat&&!db.prepare("SELECT id FROM codex_session WHERE project_id=? AND run_box_id=? AND status IN ('ready','running')").get(projectId,runBoxId))throw new CodexSessionError('Finish Codex sign-in for this environment on the website first.',409,'environment_setup_required');
      if(target) {
        if(db.prepare("SELECT count(*) AS n FROM codex_session WHERE run_box_id IS NOT NULL AND status NOT IN ('stopped','error')").get().n>=maxRemote)throw new CodexSessionError('Stop an existing environment Codex session before starting another.',429);
      } else if(db.prepare("SELECT count(*) AS n FROM codex_session WHERE run_box_id IS NULL AND status <> 'stopped'").get().n>=maxActive)throw new CodexSessionError('Stop an existing Codex box before starting another.',429);
      const id=randomUUID(),stamp=now();
      const context=target
        ?`You are the Codex agent for AgentCloud project ${projectName}. Its saved repository URL is ${repoUrl||'not configured'}. Your workspace is ${target.workspacePath} on an AgentCloud environment (provider ${target.provider}, profile ${target.profileId||'default'}) with trusted shell access. Only describe hardware and repository state you have observed there. Follow the human's instructions from the desktop app.`
        :`You are the Codex agent for AgentCloud project ${projectName}. Its saved repository URL is ${repoUrl||'not configured'}. Your persistent workspace is /home/node/workspace in a local Docker CPU box. The workspace starts empty; the repository has not been cloned automatically. Do not claim AWS or GPU execution. Follow the human's instructions from the desktop app.`;
      db.prepare('INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,context,run_box_id,chat_request_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,projectId,agentId,createdBy,'initializing',stamp,stamp,context,runBoxId,newChat?requestId:null);
      event(id,randomUUID(),'status',target?'Connecting to Codex on the environment over SSH.':'Starting a local Docker CPU box for Codex.');
      void serial(id,()=>connect(id)); return get(id);
    },
    closeRunBoxSessions,sweep,
    async action(id,input) {
      requireSession(id);
      return serial(id,async()=>{
        let session=get(id),runtime=runtimes.get(id);
        const runBoxId=runBoxOf(id);
        if(input.action==='resume') {
          if(runBoxId){if(stoppedTarget(runBoxId))throw new CodexSessionError('The environment is not ready. Create a new environment to use Codex on it.');}
          else if(db.prepare("SELECT count(*) AS n FROM codex_session WHERE id<>? AND run_box_id IS NULL AND status <> 'stopped'").get(id).n>=maxActive)throw new CodexSessionError('Stop another Codex box first.',429);
          if(session.status==='running')throw new CodexSessionError('Interrupt the active turn before reconnecting.');await connect(id);return {session:get(id)};
        }
        if(input.action==='stop'&&runBoxId) {
          // Ends the SSH connection and app-server; the environment and its workspace are unchanged.
          runtimes.delete(id);runtime?.close();
          patch(id,{status:'stopped',activeTurnId:null,error:null});event(id,randomUUID(),'status','Codex session closed. The environment and its workspace are unchanged.');return {session:get(id)};
        }
        if(input.action==='stop') {
          // Reconnect only to address the existing deterministic container after server restart.
          runtimes.delete(id);
          try{if(runtime)await runtime.stop();else await stopFactory({sessionId:id,installId});}catch{runtime?.close();fail(id,'Docker stop failed. Reconnect and try again.');throw new CodexSessionError('Docker stop failed.',502);}
          patch(id,{status:'stopped',activeTurnId:null,error:null});event(id,randomUUID(),'status','Docker box stopped. Workspace and Codex history retained.');return {session:get(id)};
        }
        if(input.action==='cancelLogin') {
          // Idempotent: cancelling with nothing pending reports cancelled:false.
          const loginId=runtime?pendingLogins.get(id):undefined;
          if(!loginId)return {session:get(id),cancelled:false};
          await cancelLogin(id,runtime,loginId);
          return {session:get(id),cancelled:true};
        }
        if(!runtime)throw new CodexSessionError('Reconnect this Codex session first.');
        if(input.action==='login') {
          if(session.status!=='auth_required')throw new CodexSessionError('This session does not need sign-in.');
          const method=loginMethod(input.method);
          if(!method)throw new CodexSessionError('Unknown sign-in method.',400);
          if(runBoxId&&method!=='browser')throw new CodexSessionError('Use browser sign-in for this environment.',400);
          // One login at a time: Codex's callback server holds one port.
          const previous=pendingLogins.get(id);
          if(previous)await cancelLogin(id,runtime,previous).catch(()=>{});
          if(method==='browser') {
            let login;
            try{login=parseBrowserLoginStart(await runtime.request('account/login/start',{type:'chatgpt'}));}
            catch(error){throw new CodexSessionError(error instanceof CodexLoginError?error.message:'Codex browser sign-in unavailable.',502);}
            pendingLogins.set(id,login.loginId);
            // The authorize URL holds OAuth state and the PKCE challenge: returned to the owner only, never saved.
            return {session:get(id),login};
          }
          const login=await runtime.request('account/login/start',{type:'chatgptDeviceCode'});
          if(typeof login?.loginId==='string')pendingLogins.set(id,login.loginId);
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
        db.prepare('UPDATE codex_session SET title=? WHERE id=? AND title IS NULL').run(chatTitle(safeText(text)),id);
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
    close(){if(sweeper)clearInterval(sweeper);unsubscribe?.();const active=[...runtimes.values()];runtimes.clear();for(const runtime of active)runtime.close();},
  };
}
