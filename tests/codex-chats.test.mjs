import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {createCodexSessionService,migrateCodexSessions} from '../lib/codex-sessions.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const base={projectId:'p',agentId:'a',createdBy:'owner',runBoxId:'box'};
function fixture(){
 const db=new Database(':memory:');let signedIn=false;const calls=[];const notifications=new Map();const closed=[];
 const options={db,dataDir:'/tmp/chat-test',sweepMs:0,targets:{describe:id=>({projectId:id==='other-project'?'q':'p',provider:'docker-local',profileId:'test',state:'ready',codexState:'ready',workspacePath:'/workspace',serverKeyInstalled:true})},
 runtimeFactory:async o=>{notifications.set(o.sessionId,o.onNotification);return {close(){closed.push(o.sessionId);o.onExit();},async request(method,params){calls.push({id:o.sessionId,method,params});if(method==='account/read')return {account:signedIn?{type:'chatgpt'}:null};if(method.startsWith('thread/'))return {thread:{id:params.threadId||`thread-${o.sessionId}`,turns:[]}};return {};}};}};
 let service=createCodexSessionService(options);
 return {db,calls,notifications,closed,get service(){return service;},signIn(){signedIn=true;},signOut(){signedIn=false;},restart(){service.close();service=createCodexSessionService(options);},close(){service.close();db.close();}};
}
test('new chats require authenticated environment setup, are independent and idempotent',async()=>{
 const f=fixture();const input={...base,newChat:true,requestId:randomUUID()};
 assert.throws(()=>f.service.initialize(input),e=>e.code==='environment_setup_required');
 const setup=f.service.initialize(base);await tick();assert.equal(f.service.get(setup.id).status,'auth_required');
 assert.throws(()=>f.service.initialize(input),e=>e.code==='environment_setup_required');
 f.signIn();await f.service.action(setup.id,{action:'resume'});
 const first=f.service.initialize(input);const second=f.service.initialize({...input,requestId:randomUUID()});await tick();
 assert.notEqual(first.id,second.id);assert.equal(f.service.initialize(input).id,first.id);assert.equal(f.service.initialize(base).id,setup.id);
 assert.equal(f.service.get(first.id).isSetupSession,false);assert.equal(f.service.get(setup.id).isSetupSession,true);
 assert.notEqual(f.service.get(first.id).threadId,f.service.get(second.id).threadId);
 assert.throws(()=>f.service.initialize({...input,runBoxId:'different-box'}),/already used/);
 assert.throws(()=>f.service.initialize({...input,requestId:randomUUID(),runBoxId:'different-box'}),e=>e.code==='environment_setup_required');
 assert.throws(()=>f.service.initialize({...input,requestId:randomUUID(),runBoxId:'other-project'}),/not found/);
 assert.throws(()=>f.service.initialize({...input,requestId:'invalid'}),e=>e.status===400);
 assert.throws(()=>f.service.initialize({...input,runBoxId:null}),e=>e.status===400);
 const member=f.service.initialize({...input,createdBy:'member'});assert.notEqual(member.id,first.id);
 assert.equal(f.service.list('p').length,4);await tick();f.close();
});
test('a new chat rechecks account credentials even when an earlier connection was ready',async()=>{
 const f=fixture();f.signIn();f.service.initialize(base);await tick();f.signOut();
 const chat=f.service.initialize({...base,newChat:true,requestId:randomUUID()});await tick();
 assert.equal(f.service.get(chat.id).status,'auth_required');assert.equal(f.service.get(chat.id).threadId,null);f.close();
});
test('chat title and events persist independently, reconnect resumes exact thread after restart',async()=>{
 const f=fixture();f.signIn();const setup=f.service.initialize(base);await tick();
 const first=f.service.initialize({...base,newChat:true,requestId:randomUUID()});const second=f.service.initialize({...base,newChat:true,requestId:randomUUID()});await tick();
 await f.service.action(first.id,{action:'message',text:'  Fix\n the   layout ',requestId:randomUUID(),actor:{id:'member',name:'Member'}});
 f.notifications.get(first.id)('turn/completed',{turn:{id:'t1',status:'completed'}});
 await f.service.action(first.id,{action:'message',text:'second turn',requestId:randomUUID()});
 f.notifications.get(first.id)('turn/completed',{turn:{id:'t2',status:'completed'}});
 assert.equal(f.service.get(first.id).title,'Fix the layout');assert.equal(f.service.get(second.id).title,'New chat');
 assert.equal(f.service.snapshot(second.id).events.some(e=>e.kind==='user'),false);
 const thread=f.service.get(first.id).threadId;f.restart();assert.equal(f.service.get(first.id).status,'error');
 await f.service.action(first.id,{action:'resume'});assert.equal(f.service.get(first.id).threadId,thread);
 assert.equal(f.calls.at(-1).method,'thread/resume');assert.equal(f.calls.at(-1).params.threadId,thread);
 assert.equal(f.service.get(first.id).title,'Fix the layout');assert.equal(f.service.snapshot(first.id).events.filter(e=>e.kind==='user').length,2);
 assert.equal(f.service.initialize(base).id,setup.id);f.close();
});
test('migration preserves canonical legacy rows and creates multiple chat slots without foreign-key damage',()=>{
 const db=new Database(':memory:');migrateCodexSessions(db);
 db.prepare("INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id,thread_id) VALUES ('old','p','a','owner','ready','now','now','box','old-thread')").run();
 db.prepare("INSERT INTO codex_session_event(session_id,event_id,kind,text,created_at,updated_at) VALUES ('old','e','user','Old history','now','now')").run();
 db.exec('DROP INDEX codex_session_setup_target; DROP INDEX codex_session_chat_request; ALTER TABLE codex_session DROP COLUMN chat_request_id; ALTER TABLE codex_session DROP COLUMN title; CREATE UNIQUE INDEX codex_session_target ON codex_session(project_id,agent_id,COALESCE(run_box_id,\'\'))');
 migrateCodexSessions(db);migrateCodexSessions(db);
 const old=db.prepare("SELECT * FROM codex_session WHERE id='old'").get();assert.equal(old.title,'Old history');assert.equal(old.chat_request_id,null);assert.equal(old.thread_id,'old-thread');
 db.prepare("INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id,chat_request_id) VALUES ('new','p','a','owner','ready','now','now','box','request')").run();
 assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_session_event').get().n,1);db.close();
});

test('delete removes independent chat history, rejects running/setup, and ignores late callbacks',async()=>{
 const f=fixture();f.signIn();const setup=f.service.initialize(base);await tick();
 const chat=f.service.initialize({...base,newChat:true,requestId:randomUUID()});await tick();
 await assert.rejects(f.service.delete(setup.id),/setup sessions cannot/);
 await f.service.action(chat.id,{action:'message',text:'saved history',requestId:randomUUID()});
 await assert.rejects(f.service.delete(chat.id),/Stop the active response/);
 f.notifications.get(chat.id)('turn/completed',{turn:{id:'t',status:'completed'}});
 f.service.setConversationStatus(chat.id,{projectId:'p',status:'done',actor:{id:'owner',name:'Owner'}});
 assert.deepEqual(await f.service.delete(chat.id),{deleted:true,id:chat.id});
 assert.ok(f.closed.includes(chat.id));assert.ok(!f.closed.includes(setup.id));
 f.notifications.get(chat.id)('item/agentMessage/delta',{itemId:'late',delta:'late output'});
 assert.throws(()=>f.service.get(chat.id),e=>e.status===404);
 for(const table of ['codex_session_event','codex_turn_request','codex_conversation_status','codex_conversation_status_change'])
   assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(chat.id).n,0);
 assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
 f.restart();assert.throws(()=>f.service.get(chat.id),e=>e.status===404);assert.equal(f.service.get(setup.id).id,setup.id);f.close();
});
test('rename validates titles, survives first message and restart, and permits active chats',async()=>{
 const f=fixture();f.signIn();const setup=f.service.initialize(base);await tick();
 const chat=f.service.initialize({...base,newChat:true,requestId:randomUUID()});await tick();
 for(const title of ['', '   ',null,'x'.repeat(121)])assert.throws(()=>f.service.rename(chat.id,title),e=>e.status===400);
 assert.equal(f.service.rename(chat.id,'  My chat  ').session.title,'My chat');
 await f.service.action(chat.id,{action:'message',text:'Different automatic title',requestId:randomUUID()});
 assert.equal(f.service.get(chat.id).title,'My chat');
 assert.equal(f.service.rename(chat.id,'Active chat').session.title,'Active chat');
 assert.equal(f.service.rename(setup.id,'Setup history').session.title,'Setup history');
 f.restart();assert.equal(f.service.get(chat.id).title,'Active chat');f.close();
});
