import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {createCodexSessionService} from '../lib/codex-sessions.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture({signedIn=true}={}) {
 const db=new Database(':memory:');let callbacks;const calls=[];
 const runtime={async request(method,params){calls.push({method,params});
  if(method==='account/read')return {account:signedIn?{type:'chatgpt'}:null};
  if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread-1',turns:[]}};
  if(method==='account/login/start')return {type:'chatgptDeviceCode',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'};
  if(method==='turn/start'){callbacks.onNotification('turn/started',{turn:{id:'turn-1'}});return {turn:{id:'turn-1'}};}
  return {};
 },close(){},async stop(){}};
 const service=createCodexSessionService({db,dataDir:'/tmp/codex-test',runtimeFactory:async options=>{callbacks=options;return runtime;}});
 return {db,service,calls,notify:(m,p)=>callbacks.onNotification(m,p)};
}
test('initialization is idempotent and waits for actual account/thread',async()=>{
 const f=fixture({signedIn:false});const a=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});
 assert.equal(a.status,'initializing');assert.equal(f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'}).id,a.id);
 await tick();assert.equal(f.service.get(a.id).status,'auth_required');assert.equal(f.calls.some(x=>x.method==='thread/start'),false);
 const result=await f.service.action(a.id,{action:'login'});assert.equal(result.login.userCode,'TEST-CODE');
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
test('restart marks lost connections honestly and preserves history',async()=>{
 const f=fixture();const a=f.service.initialize({projectId:'p',agentId:'a',createdBy:'u'});await tick();f.service.close();
 const restarted=createCodexSessionService({db:f.db,dataDir:'/tmp/codex-test',runtimeFactory:async()=>{throw Error('offline');}});
 assert.equal(restarted.get(a.id).status,'error');assert.equal(restarted.get(a.id).threadId,'thread-1');assert(restarted.snapshot(a.id).events.length);
 await assert.rejects(restarted.action(a.id,{action:'message',text:'test',requestId:randomUUID()}),/Reconnect/);f.db.close();
});
