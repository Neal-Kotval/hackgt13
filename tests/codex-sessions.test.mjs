import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {createCodexSessionService} from '../lib/codex-sessions.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture({signedIn=true,turns=[]}={}) {
 const db=new Database(':memory:');let callbacks;const calls=[];const connections=new Map();
 const runtime={async request(method,params){calls.push({method,params});
  if(method==='account/read')return {account:signedIn?{type:'chatgpt'}:null};
  if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread-1',turns}};
  if(method==='account/login/start')return {type:'chatgptDeviceCode',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'};
  if(method==='turn/start'){callbacks.onNotification('turn/started',{turn:{id:'turn-1'}});return {turn:{id:'turn-1'}};}
  return {};
 },close(){},async stop(){}};
 const service=createCodexSessionService({db,dataDir:'/tmp/codex-test',runtimeFactory:async options=>{callbacks=options;connections.set(options.sessionId,options);return runtime;}});
 return {db,service,calls,notifySession:(id,m,p)=>connections.get(id).onNotification(m,p),exit:()=>callbacks.onExit(),notify:(m,p)=>callbacks.onNotification(m,p)};
}
test('initialization is idempotent and waits for actual account/thread',async()=>{
 const f=fixture({signedIn:false});const a=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});
 assert.equal(a.status,'initializing');assert.equal(f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'}).id,a.id);
 await tick();assert.equal(f.service.get(a.id).status,'auth_required');assert.equal(f.calls.some(x=>x.method==='thread/start'),false);
 const result=await f.service.action(a.id,{action:'login',method:'deviceCode'});assert.equal(result.login.userCode,'TEST-CODE');
 assert.equal(JSON.stringify(f.service.snapshot(a.id)).includes('TEST-CODE'),false);f.service.close();f.db.close();
});
test('message idempotency, real streamed snapshots, interrupt confirmation and persistence',async()=>{
 const f=fixture();const a=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 assert.equal(f.service.get(a.id).status,'ready');const req={action:'message',text:'List files',requestId:randomUUID()};
 await Promise.all([f.service.action(a.id,req),f.service.action(a.id,req)]);
 assert.equal(f.calls.filter(x=>x.method==='turn/start').length,1);
 assert.equal(f.service.get(a.id).status,'running');
 await assert.rejects(f.service.action(a.id,{...req,text:'Different'}),/already used/);
 await assert.rejects(f.service.action(a.id,{...req,requestId:randomUUID()}),/ready/);
 f.notify('item/agentMessage/delta',{itemId:'reply',delta:'Hello '});f.notify('item/agentMessage/delta',{itemId:'reply',delta:'world'});
 f.notify('item/completed',{item:{id:'cmd',type:'commandExecution',command:'pwd',status:'completed',exitCode:0,aggregatedOutput:'/home/node/workspace'}});
 assert.equal(f.service.snapshot(a.id).events.find(x=>x.id==='reply').text,'Hello world');
 await f.service.action(a.id,{action:'interrupt'});assert.equal(f.service.get(a.id).status,'running');
 f.notify('turn/completed',{turn:{id:'turn-1',status:'interrupted'}});assert.equal(f.service.get(a.id).status,'ready');
 await f.service.action(a.id,{action:'stop'});assert.equal(f.service.get(a.id).status,'stopped');
 await f.service.action(a.id,{action:'resume'});assert.equal(f.service.get(a.id).threadId,'thread-1');assert(f.calls.some(x=>x.method==='thread/resume'));
 assert.equal(f.service.list('other').length,0);f.service.close();f.db.close();
});
test('one shared conversation retains each human instruction with its actor',async()=>{
 const f=fixture();const session=f.service.initialize({projectId:'p',agentId:'a',createdBy:'owner'});await tick();
 await f.service.action(session.id,{action:'message',text:'Build the API',requestId:randomUUID(),actor:{id:'owner',name:'Alex Owner'}});
 f.notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
 await f.service.action(session.id,{action:'message',text:'Add pagination',requestId:randomUUID(),actor:{id:'member',name:'Sam Member'}});
 const messages=f.service.snapshot(session.id).events.filter(event=>event.kind==='user');
 assert.deepEqual(messages.map(event=>({text:event.text,actorId:event.actorId,actorName:event.actorName})),[
  {text:'Build the API',actorId:'owner',actorName:'Alex Owner'},
  {text:'Add pagination',actorId:'member',actorName:'Sam Member'},
 ]);
 f.service.close();f.db.close();
});
test('restart marks lost connections honestly and preserves history',async()=>{
 const f=fixture();const a=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();f.service.close();
 const restarted=createCodexSessionService({db:f.db,dataDir:'/tmp/codex-test',runtimeFactory:async()=>{throw Error('offline');}});
 assert.equal(restarted.get(a.id).status,'error');assert.equal(restarted.get(a.id).threadId,'thread-1');assert(restarted.snapshot(a.id).events.length);
 await assert.rejects(restarted.action(a.id,{action:'message',text:'test',requestId:randomUUID()}),/Reconnect/);f.db.close();
});
test('empty unpersisted Codex threads can reconnect; submitted turns never get replaced',async()=>{
 const db=new Database(':memory:');let starts=0;
 const runtime={async request(method){if(method==='account/read')return {account:{type:'chatgpt'}};if(method==='thread/resume')throw Error('No saved rollout');if(method==='thread/start')return {thread:{id:`thread-${++starts}`}};if(method==='turn/start')throw Error('ambiguous');},close(){},async stop(){}};
 const service=createCodexSessionService({db,dataDir:'/tmp/test',runtimeFactory:async()=>runtime});
 const s=service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 await service.action(s.id,{action:'resume'});assert.equal(starts,2);
 const input={action:'message',text:'run',requestId:randomUUID()};
 await assert.rejects(service.action(s.id,input),e=>e.code==='ambiguous_turn');
 await service.action(s.id,{action:'resume'});assert.equal(service.get(s.id).status,'error');assert.equal(starts,2);
 // Even if an operator recovers the original thread, unknown requests never become success.
 db.prepare("UPDATE codex_session SET status='ready'").run();
 await service.action(s.id,{action:'resume'});assert.equal(starts,2);
 service.close();db.close();
});
test('failed starts are never acknowledged as successful retries',async()=>{
 const db=new Database(':memory:');let fail=true;
 const runtime={async request(method){if(method==='account/read')return {account:{type:'chatgpt'}};if(method.startsWith('thread/'))return {thread:{id:'t'}};if(method==='turn/start'&&fail)throw Error('lost');return {};},close(){},async stop(){}};
 const service=createCodexSessionService({db,dataDir:'/tmp/test',runtimeFactory:async()=>runtime});const s=service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 const input={action:'message',text:'run',requestId:randomUUID()};await assert.rejects(service.action(s.id,input),e=>e.code==='ambiguous_turn');fail=false;
 await service.action(s.id,{action:'resume'});await assert.rejects(service.action(s.id,input),e=>e.code==='ambiguous_turn');
 await service.action(s.id,{...input,requestId:randomUUID()});service.close();db.close();
});
test('command and file events retain fine-grained details through streaming and restart',async()=>{
 const f=fixture();const s=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 f.notify('item/started',{item:{id:'cmd',type:'commandExecution',command:'npm test',cwd:'/workspace',status:'inProgress'}});
 f.notify('item/commandExecution/outputDelta',{itemId:'cmd',delta:'First test passed\n'});
 assert.equal(f.service.snapshot(s.id).events.find(e=>e.id==='cmd').details.output,'First test passed\n');
 f.notify('item/completed',{item:{id:'cmd',type:'commandExecution',status:'completed',exitCode:0,durationMs:123}});
 f.notify('item/completed',{item:{id:'file',type:'fileChange',status:'completed',changes:[{path:'src/app.ts',kind:{type:'update',move_path:'src/main.ts'},diff:'@@ -1 +1 @@\n-old\n+new'}]}});
 const events=f.service.snapshot(s.id).events;
 assert.equal(events.filter(e=>e.id==='cmd').length,1);
 assert.deepEqual(events.find(e=>e.id==='cmd').details,{type:'commandExecution',status:'completed',command:'npm test',cwd:'/workspace',output:'First test passed\n',exitCode:0,durationMs:123});
 assert.deepEqual(events.find(e=>e.id==='file').details.changes,[{path:'src/app.ts',kind:'update',movePath:'src/main.ts',diff:'@@ -1 +1 @@\n-old\n+new'}]);
 f.service.close();
 const restarted=createCodexSessionService({db:f.db,dataDir:'/tmp/codex-test',runtimeFactory:async()=>{throw Error('offline');}});
 assert.deepEqual(restarted.snapshot(s.id).events.find(e=>e.id==='cmd').details,events.find(e=>e.id==='cmd').details);
 restarted.close();f.db.close();
});
test('migration removes command details already saved by older versions',async()=>{
 const f=fixture();const s=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();f.service.close();
 const secret='-----BEGIN OPENSSH PRIVATE KEY----- private-material';
 f.db.prepare("INSERT INTO codex_session_event(session_id,event_id,kind,text,created_at,updated_at) VALUES(?,?,'command',?,?,?)").run(s.id,'legacy',`cat secret\ncompleted · exit 0\n${secret}`,'2026-01-01','2026-01-01');
 f.db.prepare("DELETE FROM codex_session_migration WHERE name='remove-raw-command-output-v1'").run();
 const restored=createCodexSessionService({db:f.db,dataDir:'/tmp/codex-test',runtimeFactory:async()=>{throw Error('offline');}});
 assert.equal(JSON.stringify(restored.snapshot(s.id)).includes(secret),false);
 assert.equal(f.db.prepare('SELECT text FROM codex_session_event WHERE event_id=?').get('legacy').text.includes(secret),false);
 f.db.close();
});

test('execution details redact secrets across output chunks and patch fields before saving',async()=>{
 const f=fixture();const s=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 const notify=delta=>f.notify('item/commandExecution/outputDelta',{itemId:'cmd',delta});
 f.notify('item/started',{item:{id:'cmd',type:'commandExecution',command:'TOKEN="command secret" npm test',status:'inProgress'}});
 notify('passed\nAPI_TOKEN=split');
 let saved=JSON.stringify(f.db.prepare('SELECT * FROM codex_session_event').all());
 assert(!saved.includes('split')); assert(!saved.includes('command secret'));
 notify('credential\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate');
 notify('-material\n-----END OPENSSH PRIVATE KEY-----\nAuthorization: Bearer bearer-secret\n');
 f.notify('item/completed',{item:{id:'cmd',type:'commandExecution',status:'completed',exitCode:0}});
 f.notify('item/completed',{item:{id:'file',type:'fileChange',status:'completed',changes:[{path:'src/config.ts',kind:{type:'add'},diff:'+password="file secret"\n+api_key=abc123\n+const enabled = true'}]}});
 saved=JSON.stringify(f.db.prepare('SELECT * FROM codex_session_event').all());
 for(const secret of ['splitcredential','private-material','bearer-secret','file secret','abc123'])assert(!saved.includes(secret),secret);
 assert(saved.includes('const enabled = true'));
 assert(saved.includes('[redacted private key]'));
 const before=f.service.snapshot(s.id).events.find(e=>e.id==='cmd');
 notify('late output\n');
 assert.deepEqual(f.service.snapshot(s.id).events.find(e=>e.id==='cmd'),before);
 f.service.close();f.db.close();
});
test('resume recovers authoritative execution details without duplicating items',async()=>{
 const turns=[{items:[{id:'cmd',type:'commandExecution',status:'completed',command:'pwd',cwd:'/workspace',exitCode:0,durationMs:9,aggregatedOutput:'/workspace\n'},
 {id:'file',type:'fileChange',status:'completed',changes:[{path:'a.txt',kind:{type:'delete'},diff:'-old'}]}]}];
 const f=fixture({turns});const s=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 await f.service.action(s.id,{action:'resume'});
 assert.equal(f.service.snapshot(s.id).events.filter(e=>e.id==='cmd').length,1);
 assert.equal(f.service.snapshot(s.id).events.find(e=>e.id==='cmd').details.output,'/workspace\n');
 assert.equal(f.service.snapshot(s.id).events.find(e=>e.id==='file').details.changes[0].kind,'delete');
 f.service.close();f.db.close();
});
test('large streamed output and patches have explicit retention bounds',async()=>{
 const f=fixture();const s=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 f.notify('item/commandExecution/outputDelta',{itemId:'cmd',delta:'x'.repeat(100000)});
 f.notify('item/completed',{item:{id:'cmd',type:'commandExecution',status:'completed'}});
 const command=f.service.snapshot(s.id).events.find(e=>e.id==='cmd').details;
 assert.equal(command.output.length,32768);assert.equal(command.truncated,true);
 f.notify('item/completed',{item:{id:'file',type:'fileChange',status:'completed',changes:Array.from({length:150},(_,i)=>({path:`file-${i}`,kind:{type:'update'},diff:'x'.repeat(1000)}))}});
 const patch=f.service.snapshot(s.id).events.find(e=>e.id==='file').details;
 assert.equal(patch.changes.length,100);assert.equal(patch.truncated,true);
 assert(patch.changes.reduce((sum,c)=>sum+c.path.length+c.diff.length,0)<=32768);
 f.service.close();f.db.close();
});

test('stream lifecycle releases capacity after interruption, disconnect, stop and resume',async()=>{
 const f=fixture();const s=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 const fill=()=>{for(let i=0;i<300;i++)f.notify('item/commandExecution/outputDelta',{itemId:`pending-${i}`,delta:'unpublished secret fragment'});};
 const check=label=>{
  f.notify('item/commandExecution/outputDelta',{itemId:label,delta:'fresh output\n'});
  assert.equal(f.service.snapshot(s.id).events.find(e=>e.id===label)?.details.output,'fresh output\n');
 };
 fill();f.notify('turn/completed',{turn:{id:'interrupted',status:'interrupted'}});check('after-interrupt');
 fill();f.exit();await f.service.action(s.id,{action:'resume'});check('after-disconnect');
 fill();await f.service.action(s.id,{action:'stop'});await f.service.action(s.id,{action:'resume'});check('after-stop');
 fill();await f.service.action(s.id,{action:'resume'});check('after-resume');
 f.service.close();f.db.close();
});
test('command flags and raw AgentCloud credentials are redacted in saved details',async()=>{
 const f=fixture();const s=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 const token='AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
 assert.equal(token.length,43);
 f.notify('item/completed',{item:{id:'cmd',type:'commandExecution',status:'completed',command:`tool --token flag-token --password "two words" --api-key=key-secret`,aggregatedOutput:`issued ${token}\n-----BEGIN RSA PRIVATE KEY-----\nkey-material\n-----END RSA PRIVATE KEY-----`}});
 const saved=JSON.stringify(f.db.prepare('SELECT * FROM codex_session_event').all());
 for(const secret of ['flag-token','two words','key-secret',token,'key-material'])assert(!saved.includes(secret),secret);
 assert(f.service.snapshot(s.id).events.find(e=>e.id==='cmd').details.command.includes('--token [redacted]'));
 f.service.close();f.db.close();
});

test('closing one session preserves the other session output stream',async()=>{
 const f=fixture();const first=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();
 const second=f.service.initialize({projectId:'p',agentId:'b',createdBy:'u'});await tick();
 f.notifySession(first.id,'item/commandExecution/outputDelta',{itemId:'shared-item-id',delta:'first part '});
 f.notifySession(second.id,'item/commandExecution/outputDelta',{itemId:'shared-item-id',delta:'discarded '});
 f.notifySession(second.id,'turn/completed',{turn:{id:'t',status:'interrupted'}});
 f.notifySession(first.id,'item/commandExecution/outputDelta',{itemId:'shared-item-id',delta:'second part\n'});
 assert.equal(f.service.snapshot(first.id).events.find(e=>e.id==='shared-item-id').details.output,'first part second part\n');
 f.service.close();f.db.close();
});
