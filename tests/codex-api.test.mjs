import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {copyFile,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import {prepareAuth} from './auth-fixture.mjs';
import { copyRunBoxAccess } from './run-box-access-fixture.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'codex-api-'));
process.env.AGENTCLOUD_DATA_DIR=path.join(dir,'data');
await writeFile(path.join(dir,'package.json'),'{"type":"module"}');
async function compile(source,name) {
 const code=ts.transpileModule(await readFile(new URL(source,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
 .replaceAll('@/lib/','./').replace(/from ["']\.\/([\w-]+)["']/g,"from './$1.js'");
 await writeFile(path.join(dir,name),code);return import(path.join(dir,name));
}
await copyFile(new URL('../lib/machine-catalog.mjs',import.meta.url),path.join(dir,'machine-catalog.mjs'));await compile('../lib/resource-profiles.ts','resource-profiles.js');await compile('../lib/store.ts','store.js');await compile('../lib/http.ts','http.js');
const fixture=await prepareAuth(dir),store=await import(path.join(dir,'store.js'));
await copyRunBoxAccess(dir);
// Stub only execution; all employee/session/organization checks use real Better Auth.
await writeFile(path.join(dir,'codex-service.js'),`import {failure} from './http.js'; import {InputError} from './store.js';
export const codexEnabled=()=>true;export const codexFailure=failure;
let saved=[];const events=new Map();export function codexService(){return {validateEnvironment:(projectId,runBoxId)=>{if(runBoxId!=='ready-env')throw new InputError('Environment not found or not ready',409);},list:(projectId)=>saved.filter(session=>session.projectId===projectId),initialize:({projectId,agentId,runBoxId,newChat,createdBy})=>{let session=saved.find(row=>row.projectId===projectId&&row.agentId===agentId&&!newChat);if(session)return session;session={id:saved.length?'s'+(saved.length+1):'s1',projectId,agentId,createdBy,status:'ready',isSetupSession:!newChat,target:runBoxId?{kind:'runBox',runBoxId}:{kind:'local'}};saved.push(session);return session;},get:(id)=>{const row=saved.find(row=>row.id===id);if(!row)throw new InputError('Not found',404);return row;},delete:async(id)=>{saved=saved.filter(row=>row.id!==id);return {deleted:true,id};},rename:(id,title)=>{const session=saved.find(row=>row.id===id);session.title=title;return {session};},snapshot:(id)=>({session:saved.find(row=>row.id===id),events:events.get(id)||[]}),action:async(id,input)=>{if(input.action==='message'){const entries=events.get(id)||[];entries.push({kind:'user',text:input.text,actorId:input.actor.id,actorName:input.actor.name});events.set(id,entries);}return {session:saved.find(row=>row.id===id)};}};}`);
const routes=await compile('../app/api/codex-sessions/route.ts','sessions.js');
const detail=await compile('../app/api/codex-sessions/[id]/route.ts','detail.js');
const owner=fixture.users[0],member=fixture.users[1];
const p=(await store.action({type:'createProject',name:'Codex API test',repo:'https://example.com/repo',compute:'Hosted Linux',template:'blank'})).id;
fixture.grantMembership(owner.id,p,'owner');fixture.grantMembership(member.id,p,'member');
const agent=(await store.action({type:'addAgent',projectId:p,name:'Codex',client:'Codex',role:'Developer',branch:'agent/codex'})).agentId;
function request(body,cookie,url='/api/codex-sessions') {return new Request(`http://localhost:3000${url}`,{method:body?'POST':'GET',headers:{origin:'http://localhost:3000','content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});}
after(async()=>{fixture.getDatabase().close();await rm(dir,{recursive:true,force:true});});
test('Codex setup is owner-scoped; session reads and messages require project membership',async()=>{
 const input={projectId:p,agentId:agent};
 assert.equal((await routes.POST(request(input))).status,401);
 assert.equal((await routes.POST(request(input,member.cookie))).status,403);
 assert.equal((await routes.POST(request({...input,agentId:'other'},owner.cookie))).status,400);
 assert.equal((await routes.POST(request({...input,runBoxId:'../etc'},owner.cookie))).status,400);
 assert.equal((await routes.POST(request({...input,runBoxId:7},owner.cookie))).status,400);
 assert.equal((await routes.POST(request({...input,runBoxId:'rb-1'},member.cookie))).status,403);
 assert.equal((await routes.POST(request(input,owner.cookie))).status,202);
 const ctx={params:Promise.resolve({id:'s1'})};
 assert.equal((await detail.GET(request(null,member.cookie),ctx)).status,200);
 assert.equal((await detail.POST(request({action:'login'},member.cookie),ctx)).status,403);
 assert.equal((await detail.POST(request({action:'login',method:'browser'},member.cookie),ctx)).status,403);
 assert.equal((await detail.POST(request({action:'cancelLogin'},member.cookie),ctx)).status,403);
 assert.equal((await detail.POST(request({action:'message',text:'hello'},member.cookie),ctx)).status,200);
 const ownerView=await (await detail.GET(request(null,owner.cookie),ctx)).json();
 assert.deepEqual(ownerView.events.map(({text,actorId,actorName})=>({text,actorId,actorName})),[
  {text:'hello',actorId:member.id,actorName:member.name},
 ]);
 assert.equal((await detail.POST(request({action:'message',text:'from owner'},owner.cookie),ctx)).status,200);
 const memberView=await (await detail.GET(request(null,member.cookie),ctx)).json();
 assert.deepEqual(memberView.events.map(({text,actorId})=>({text,actorId})),[
  {text:'hello',actorId:member.id},{text:'from owner',actorId:owner.id},
 ]);
 assert.equal((await detail.POST(request({action:'resume'},member.cookie),ctx)).status,403);
 assert.equal((await routes.POST(request({...input,newChat:'yes'},member.cookie))).status,400);
 assert.equal((await routes.POST(request({...input,newChat:true},member.cookie))).status,400);
 const chatResponse=await routes.POST(request({...input,newChat:true,runBoxId:'rb-1',requestId:'test'},member.cookie));
 assert.equal(chatResponse.status,202);
 const chat=await chatResponse.json();
 assert.equal((await detail.POST(request({action:'resume'},member.cookie),{params:Promise.resolve({id:chat.session.id})})).status,200);
 assert.equal((await detail.POST(request({action:'login'},member.cookie),ctx)).status,403);
 assert.equal((await detail.POST(request({action:'stop'},member.cookie),ctx)).status,403);
 const cross=request({action:'message'},owner.cookie);cross.headers.set('origin','https://other.example');
 assert.equal((await detail.POST(cross,ctx)).status,403);
 fixture.getDatabase().prepare('DELETE FROM project_membership WHERE user_id=?').run(member.id);
 assert.equal((await detail.GET(request(null,member.cookie),ctx)).status,403);
 assert.equal((await detail.POST(request({action:'message'},member.cookie),ctx)).status,403);
 assert.equal((await routes.POST(request({...input,newChat:true,runBoxId:'rb-1',requestId:'test'},member.cookie))).status,403);
});

test('managed setup validates before persisting and reuses a tokenless identity and canonical session',async()=>{
 const projectId=(await store.action({type:'createProject',name:'Managed setup',repo:'https://example.com/repo',compute:'Hosted Linux',template:'blank'})).id;
 fixture.grantMembership(owner.id,projectId,'owner');fixture.grantMembership(member.id,projectId,'member');
 const disk=async()=>JSON.parse(await readFile(path.join(process.env.AGENTCLOUD_DATA_DIR,'state.json'),'utf8'));
 const input={projectId,runBoxId:'ready-env'};
 const before=await disk();
 assert.equal((await routes.POST(request(input,member.cookie))).status,403);
 assert.equal((await routes.POST(request({...input,runBoxId:'mismatched-env'},owner.cookie))).status,409);
 assert.equal((await routes.POST(request({projectId},owner.cookie))).status,400);
 assert.deepEqual(await disk(),before,'denied or invalid targets do not write identities or credentials');
 const response=await routes.POST(request(input,owner.cookie));assert.equal(response.status,202);
 const first=await response.json();assert.equal('token' in first,false);
 const after=await disk();assert.deepEqual(after.credentials,before.credentials);
 const agents=after.state.projects.find(p=>p.id===projectId).agents;
 assert.equal(agents.length,1);assert.equal(agents[0].client,'Codex');assert.equal(first.session.agentId,agents[0].id);
 const duplicate=await routes.POST(request(input,owner.cookie));assert.equal(duplicate.status,202);
 assert.equal((await duplicate.json()).session.agentId,first.session.agentId);
 assert.deepEqual(await disk(),after);
});

test('managed setup preserves an existing Codex identity and legacy credential',async()=>{
 const projectId=(await store.action({type:'createProject',name:'Existing Codex setup',repo:'https://example.com/repo',compute:'Hosted Linux',template:'blank'})).id;
 fixture.grantMembership(owner.id,projectId,'owner');
 const existing=(await store.action({type:'addAgent',projectId,name:'Existing Codex',client:'Codex',role:'Developer',branch:'agents/existing'})).agentId;
 const before=JSON.parse(await readFile(path.join(process.env.AGENTCLOUD_DATA_DIR,'state.json'),'utf8'));
 const results=await Promise.all([1,2].map(()=>routes.POST(request({projectId,runBoxId:'ready-env'},owner.cookie))));
 for(const response of results){assert.equal(response.status,202);assert.equal((await response.json()).session.agentId,existing);}
 const after=JSON.parse(await readFile(path.join(process.env.AGENTCLOUD_DATA_DIR,'state.json'),'utf8'));
 assert.deepEqual(after,before);
});

test('a second managed agent requires ready same-box setup and is idempotent',async()=>{
 const projectId=(await store.action({type:'createProject',name:'Peer setup',repo:'https://example.com/repo',compute:'Hosted Linux',template:'blank'})).id;
 fixture.grantMembership(owner.id,projectId,'owner');fixture.grantMembership(member.id,projectId,'member');
 const requestId='ce0f89c0-0fb6-4707-bcc6-6d330bcfe395';
 const input={projectId,runBoxId:'ready-env',newAgent:true,requestId};
 assert.equal((await routes.POST(request(input,owner.cookie))).status,409);
 assert.equal((await routes.POST(request({projectId,runBoxId:'ready-env'},owner.cookie))).status,202);
 assert.equal((await routes.POST(request(input,member.cookie))).status,403);
 assert.equal((await routes.POST(request({...input,agentId:'existing'},owner.cookie))).status,400);
 assert.equal((await routes.POST(request({...input,requestId:'bad'},owner.cookie))).status,400);
 const response=await routes.POST(request(input,owner.cookie));assert.equal(response.status,202);
 const first=await response.json();assert.equal('token' in first,false);
 const again=await routes.POST(request(input,owner.cookie));assert.equal(again.status,202);
 assert.equal((await again.json()).session.agentId,first.session.agentId);
 const disk=JSON.parse(await readFile(path.join(process.env.AGENTCLOUD_DATA_DIR,'state.json'),'utf8'));
 const agents=disk.state.projects.find(p=>p.id===projectId).agents;
 assert.equal(agents.length,2);
 assert.equal(agents[1].name,'Codex 2');
 assert.equal(agents[1].setupRequestId,requestId);
 assert.equal(agents[1].branch,`agent/${agents[1].id}`);
});

test('chat rename and deletion require same-origin authenticated creator or project owner',async()=>{
 const projectId=(await store.action({type:'createProject',name:'Chat management',repo:'https://example.com/repo',compute:'Hosted Linux',template:'blank'})).id;
 fixture.grantMembership(owner.id,projectId,'owner');fixture.grantMembership(member.id,projectId,'member');
 const agentId=(await store.action({type:'addAgent',projectId,name:'Codex',client:'Codex',role:'Developer',branch:'agent/codex'})).agentId;
 const create=async(cookie)=>(await (await routes.POST(request({projectId,agentId,runBoxId:'ready-env',newChat:true,requestId:'test'},cookie))).json()).session;
 const own=await create(owner.cookie),other=await create(member.cookie);
 const mutation=(method,cookie,origin='http://localhost:3000')=>new Request('http://localhost:3000/api/codex-sessions/'+own.id,{method,headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},...(method==='PATCH'?{body:JSON.stringify({title:'Renamed'})}:{})});
 for(const method of ['PATCH','DELETE']){
   const ctx={params:Promise.resolve({id:own.id})};
   assert.equal((await detail[method](mutation(method),ctx)).status,401);
   assert.equal((await detail[method](mutation(method,owner.cookie,'https://other.example'),ctx)).status,403);
   assert.equal((await detail[method](mutation(method,member.cookie),ctx)).status,403);
 }
 assert.equal((await detail.PATCH(mutation('PATCH',member.cookie),{params:Promise.resolve({id:other.id})})).status,200);
 assert.equal((await detail.PATCH(mutation('PATCH',owner.cookie),{params:Promise.resolve({id:other.id})})).status,200);
 const creatorDelete=await detail.DELETE(mutation('DELETE',member.cookie),{params:Promise.resolve({id:other.id})});
 assert.deepEqual(await creatorDelete.json(),{deleted:true,id:other.id});
 const memberChat=await create(member.cookie);
 assert.equal((await detail.DELETE(mutation('DELETE',owner.cookie),{params:Promise.resolve({id:memberChat.id})})).status,200);
 fixture.getDatabase().prepare('DELETE FROM project_membership WHERE user_id=? AND project_id=?').run(member.id,projectId);
 assert.equal((await detail.DELETE(mutation('DELETE',member.cookie),{params:Promise.resolve({id:own.id})})).status,403);
});
