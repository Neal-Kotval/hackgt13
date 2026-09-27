import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createCodexSessionService, ENVIRONMENT_STOPPED, migrateCodexSessions} from '../lib/codex-sessions.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const ready={runBoxId:'rb-1',projectId:'p',provider:'aws-ec2',profileId:'aws-cpu',state:'ready',stopRequested:false,codexState:'ready',workspacePath:'/home/agentcloud/agentcloud/rb-1/repo',serverKeyInstalled:true};
function fixture({targets={'rb-1':{...ready}},apiKey='',runtimeError=null}={}) {
 const db=new Database(':memory:');const calls=[];const factories=[];let listener;const closed=[];
 const service=createCodexSessionService({db,dataDir:'/tmp/codex-target-test',apiKey,sweepMs:0,
  targets:{describe:id=>targets[id]??null},onStopRequested:fn=>{listener=fn;return()=>{listener=null;};},
  runtimeFactory:async options=>{factories.push(options);if(runtimeError)throw runtimeError;const runtime={
   async request(method,params){calls.push({method,params,runBoxId:options.runBoxId});
    if(method==='account/read')return {account:null};
    if(method==='account/login/start')return {type:'chatgpt',loginId:'login-1',authUrl:'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'};
    if(method.startsWith('thread/'))return {thread:{id:'thread-r'}};return {};},
   close(){closed.push(options.sessionId);},async stop(){}};return runtime;}});
 return {db,service,calls,factories,targets,closed,stop:id=>listener(id)};
}
test('initialize validates the environment target',()=>{
 const f=fixture({targets:{'rb-1':{...ready},'other':{...ready,runBoxId:'other',projectId:'q'},'busy':{...ready,runBoxId:'busy',state:'verifying'},
  'nocodex':{...ready,runBoxId:'nocodex',codexState:'failed'},'old':{...ready,runBoxId:'old',serverKeyInstalled:false},'stopping':{...ready,runBoxId:'stopping',stopRequested:true}}});
 const base={projectId:'p',agentId:'a',createdBy:'u'};
 const reject=(runBoxId,pattern,status=409)=>{
  assert.throws(()=>f.service.validateEnvironment(base.projectId,runBoxId),e=>e.status===status&&pattern.test(e.message));
  assert.throws(()=>f.service.initialize({...base,runBoxId}),e=>e.status===status&&pattern.test(e.message));
 };
 reject('missing',/not found/);reject('other',/not found/);reject('busy',/must be ready/);reject('stopping',/must be ready/);
 reject('nocodex',/Codex is not ready/);reject('old',/^Create a new environment to use Codex on it\.$/);reject('../x',/Invalid/,400);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM codex_session').get().n,0);f.service.close();f.db.close();
});
test('local and environment sessions coexist; remote runs in workspacePath and browser login works and device-code is rejected',async()=>{
 const f=fixture({apiKey:'sk-operator-key-never-remote'});const base={projectId:'p',agentId:'a',createdBy:'u'};
 const local=f.service.initialize(base);const remote=f.service.initialize({...base,runBoxId:'rb-1'});
 assert.notEqual(local.id,remote.id);assert.equal(f.service.initialize({...base,runBoxId:'rb-1'}).id,remote.id);
 assert.deepEqual(local.target,{kind:'local'});assert.equal(local.provider,'docker-local');
 assert.deepEqual(remote.target,{kind:'runBox',runBoxId:'rb-1',provider:'aws-ec2',profileId:'aws-cpu',state:'ready'});
 await tick();await tick();
 assert.equal(f.factories.find(x=>x.sessionId===remote.id).runBoxId,'rb-1');
 assert.equal(f.factories.find(x=>x.sessionId===local.id).runBoxId,null);
 assert.equal(f.calls.some(c=>c.runBoxId==='rb-1'&&c.method==='account/login/start'),false,'operator API key is never sent to an environment');
 assert.equal(f.service.get(remote.id).status,'auth_required');
 const {login}=await f.service.action(remote.id,{action:'login'});
 assert.equal(login.method,'browser');
 await assert.rejects(f.service.action(remote.id,{action:'login',method:'deviceCode'}),error=>error.status===400);
 assert.equal(f.calls.some(c=>c.method==='account/login/start'&&c.params.type==='chatgptDeviceCode'),false);
 const context=f.db.prepare('SELECT context FROM codex_session WHERE id=?').get(remote.id).context;
 assert.match(context,/\/home\/agentcloud\/agentcloud\/rb-1\/repo/);assert.doesNotMatch(context,/local Docker/);
 f.service.close();f.db.close();
});
test('thread starts in the environment workspace; transport messages become the session error',async()=>{
 const f=fixture();f.service.close();
 const db=new Database(':memory:');const seen=[];
 const service=createCodexSessionService({db,dataDir:'/tmp/t',sweepMs:0,targets:{describe:()=>({...ready})},
  runtimeFactory:async()=>({async request(method,params){seen.push({method,params});if(method==='account/read')return {account:{type:'chatgpt'}};return {thread:{id:'t'}};},close(){},async stop(){}})});
 const s=service.initialize({projectId:'p',agentId:'a',createdBy:'u',runBoxId:'rb-1'});await tick();await tick();
 assert.equal(seen.find(x=>x.method==='thread/start').params.cwd,ready.workspacePath);assert.equal(service.get(s.id).status,'ready');
 service.close();db.close();
 const g=fixture({runtimeError:Object.assign(new Error('raw ssh: secret stderr'),{publicMessage:'Create a new environment to use Codex on it.'})});
 const r=g.service.initialize({projectId:'p',agentId:'a',createdBy:'u',runBoxId:'rb-1'});await tick();await tick();
 assert.equal(g.service.get(r.id).error,'Create a new environment to use Codex on it.');
 assert.equal(JSON.stringify(g.service.snapshot(r.id)).includes('secret stderr'),false);
 const h=fixture({runtimeError:new Error('raw ssh: secret stderr')});
 const q=h.service.initialize({projectId:'p',agentId:'a',createdBy:'u',runBoxId:'rb-1'});await tick();await tick();
 assert.equal(JSON.stringify(h.service.snapshot(q.id)).includes('secret stderr'),false);
 g.service.close();h.service.close();
});
test('stopping an environment closes its sessions and marks them Environment stopped',async()=>{
 const f=fixture();const s=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u',runBoxId:'rb-1'});
 const local=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();await tick();
 f.targets['rb-1'].stopRequested=true;f.stop('rb-1');
 assert.deepEqual(f.closed,[s.id]);
 assert.equal(f.service.get(s.id).status,'error');assert.equal(f.service.get(s.id).error,ENVIRONMENT_STOPPED);
 assert.notEqual(f.service.get(local.id).status,'error');
 await assert.rejects(f.service.action(s.id,{action:'resume'}),/not ready/);
 // Stops requested by a worker in another process are found by the state sweep.
 f.targets['rb-2']={...ready,runBoxId:'rb-2'};
 const t=f.service.initialize({projectId:'p',agentId:'b',createdBy:'u',runBoxId:'rb-2'});await tick();await tick();
 f.targets['rb-2'].state='stopped';
 assert.equal(f.service.list('p').find(x=>x.id===t.id).error,ENVIRONMENT_STOPPED);
 assert.ok(f.closed.includes(t.id));
 f.service.close();f.db.close();
});
test('an environment session stop closes the transport without touching Docker',async()=>{
 const db=new Database(':memory:');let stopFactoryCalls=0;const closed=[];
 const service=createCodexSessionService({db,dataDir:'/tmp/t',sweepMs:0,targets:{describe:()=>({...ready})},stopFactory:async()=>{stopFactoryCalls++;},
  runtimeFactory:async o=>({async request(m){return m==='account/read'?{account:null}:{};},close(){closed.push(o.sessionId);},async stop(){throw Error('no docker');}})});
 const s=service.initialize({projectId:'p',agentId:'a',createdBy:'u',runBoxId:'rb-1'});await tick();await tick();
 await service.action(s.id,{action:'stop'});
 assert.equal(service.get(s.id).status,'stopped');assert.deepEqual(closed,[s.id]);assert.equal(stopFactoryCalls,0);
 service.close();db.close();
});
test('migration adds run_box_id and preserves existing sessions, events and requests',()=>{
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE codex_session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    created_by TEXT NOT NULL, status TEXT NOT NULL, thread_id TEXT, active_turn_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '', UNIQUE(project_id, agent_id));
  CREATE TABLE codex_session_event (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES codex_session(id),
    event_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT, UNIQUE(session_id,event_id));
  CREATE TABLE codex_turn_request (session_id TEXT NOT NULL REFERENCES codex_session(id), request_id TEXT NOT NULL,
    text_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown', PRIMARY KEY(session_id,request_id));
  INSERT INTO codex_session VALUES ('s1','p','a','u','stopped','thread-1',NULL,NULL,'2026-01-01','2026-01-01','ctx');
  INSERT INTO codex_session_event(session_id,event_id,kind,text,created_at,updated_at) VALUES ('s1','e1','user','hello','2026-01-01','2026-01-01');
  INSERT INTO codex_turn_request VALUES ('s1','r1','h','accepted');`);
 migrateCodexSessions(db);migrateCodexSessions(db);
 const row=db.prepare('SELECT * FROM codex_session WHERE id=?').get('s1');
 assert.equal(row.run_box_id,null);assert.equal(row.thread_id,'thread-1');assert.equal(row.context,'ctx');
 assert.equal(db.prepare('SELECT text FROM codex_session_event WHERE session_id=?').get('s1').text,'hello');
 assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_request').get().n,1);
 assert.equal(db.pragma('foreign_keys',{simple:true}),1);assert.deepEqual(db.pragma('foreign_key_check'),[]);
 db.prepare("INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id) VALUES('s2','p','a','u','ready','x','x','rb-1')").run();
 assert.throws(()=>db.prepare("INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id) VALUES('s3','p','a','u','ready','x','x',NULL)").run(),/UNIQUE/);
 assert.throws(()=>db.prepare("INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id) VALUES('s4','p','a','u','ready','x','x','rb-1')").run(),/UNIQUE/);
 assert.throws(()=>db.prepare("INSERT INTO codex_session_event(session_id,event_id,kind,text,created_at,updated_at) VALUES ('nope','e','user','x','x','x')").run(),/FOREIGN KEY/);
 db.close();
});
