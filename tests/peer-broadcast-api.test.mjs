import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {copyFile,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import {prepareAuth} from './auth-fixture.mjs';
import { copyRunBoxAccess } from './run-box-access-fixture.mjs';

const dir=await mkdtemp(path.join(os.tmpdir(),'peer-broadcast-api-'));
process.env.AGENTCLOUD_DATA_DIR=path.join(dir,'data');
await writeFile(path.join(dir,'package.json'),'{'+'"type":"module"'+'}');
async function compile(source,name) {
 const code=ts.transpileModule(await readFile(new URL(source,import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
  .replaceAll('@/lib/','./').replace(/from ["']\.\/([\w-]+)["']/g,"from './$1.js'");
 await writeFile(path.join(dir,name),code);
 return import(path.join(dir,name));
}
await copyFile(new URL('../lib/machine-catalog.mjs',import.meta.url),path.join(dir,'machine-catalog.mjs'));
await compile('../lib/resource-profiles.ts','resource-profiles.js');
await compile('../lib/store.ts','store.js');
await compile('../lib/http.ts','http.js');
const fixture=await prepareAuth(dir),store=await import(path.join(dir,'store.js'));
await copyRunBoxAccess(dir);
await writeFile(path.join(dir,'codex-service.js'),`import {failure} from './http.js';
export const codexFailure=failure;
export const calls=[];
let projectId='',agentId='';
export function setContext(project,agent){projectId=project;agentId=agent;}
export function codexService(){return {
 get:id=>({id,projectId,agentId:id==='source'?agentId:'other-agent'}),
 broadcastPeerMessage:(id,input)=>{calls.push({id,input});return [{id:'notice'}]},
 sendPeerMessage:()=>{throw Error('Directed path was used')},
};}`);
const human=await compile('../app/api/codex-sessions/[id]/peer-messages/route.ts','human-peer.js');
const agentRoute=await compile('../app/api/agent-peer-messages/route.ts','agent-peer.js');
const {calls,setContext}=await import(path.join(dir,'codex-service.js'));
const owner=fixture.users[0],member=fixture.users[1];
const projectId=(await store.action({type:'createProject',name:'Broadcast API',repo:'https://example.com/repo',compute:'Hosted Linux',template:'blank'})).id;
fixture.grantMembership(owner.id,projectId,'owner');fixture.grantMembership(member.id,projectId,'member');
const first=await store.action({type:'addAgent',projectId,name:'A',client:'Codex',role:'Developer',branch:'agent/a'});
const second=await store.action({type:'addAgent',projectId,name:'B',client:'Codex',role:'Developer',branch:'agent/b'});
setContext(projectId,first.agentId);
const request=(body,{cookie,token}={})=>new Request('http://localhost:3000/api/peer',{method:'POST',
 headers:{origin:'http://localhost:3000','content-type':'application/json',...(cookie?{cookie}:{}),...(token?{authorization:`Bearer ${token}`}:{})},
 body:JSON.stringify(body)});
const context={params:Promise.resolve({id:'source'})};
after(async()=>{fixture.getDatabase().close();await rm(dir,{recursive:true,force:true});});

test('project member can broadcast; anonymous and malformed sends are denied',async()=>{
 const input={broadcast:true,text:'Use port 4000',requestId:'d7b439fa-d7bb-4b5b-b890-70545086876d'};
 assert.equal((await human.POST(request(input),context)).status,401);
 assert.equal((await human.POST(request({...input,broadcast:false},{cookie:member.cookie}),context)).status,400);
 assert.equal((await human.POST(request({...input,toSessionId:'target'},{cookie:member.cookie}),context)).status,400);
 const sent=await human.POST(request(input,{cookie:member.cookie}),context);
 assert.equal(sent.status,202);
 assert.deepEqual((await sent.json()).messages,[{id:'notice'}]);
 assert.equal(calls.at(-1).input.actor.id,member.id);
});

test('scoped agent token cannot broadcast as another agent',async()=>{
 const input={projectId,agentId:second.agentId,fromSessionId:'source',broadcast:true,text:'Status',requestId:'e4a338a6-8b14-4b7b-8b52-c4d76b0215ec'};
 assert.equal((await agentRoute.POST(request(input,{token:first.token}))).status,403);
 assert.equal((await agentRoute.POST(request({...input,agentId:first.agentId,toSessionId:'target'},{token:first.token}))).status,400);
 const sent=await agentRoute.POST(request({...input,agentId:first.agentId},{token:first.token}));
 assert.equal(sent.status,202);
 assert.equal(calls.at(-1).input.actor.id,first.agentId);
});
