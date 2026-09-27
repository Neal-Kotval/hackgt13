import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import {prepareAuth} from './auth-fixture.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'codex-api-'));
process.env.AGENTCLOUD_DATA_DIR=path.join(dir,'data');
await writeFile(path.join(dir,'package.json'),'{"type":"module"}');
async function compile(source,name) {
 const code=ts.transpileModule(await readFile(new URL(source,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
 .replaceAll('@/lib/','./').replace(/from ["']\.\/([\w-]+)["']/g,"from './$1.js'");
 await writeFile(path.join(dir,name),code);return import(path.join(dir,name));
}
await compile('../lib/resource-profiles.ts','resource-profiles.js');await compile('../lib/store.ts','store.js');await compile('../lib/http.ts','http.js');
const fixture=await prepareAuth(dir),store=await import(path.join(dir,'store.js'));
// Stub only execution; all employee/session/organization checks use real Better Auth.
await writeFile(path.join(dir,'codex-service.js'),`import {failure} from './http.js';
export const codexEnabled=()=>true;export const codexFailure=failure;
let saved;export function codexService(){return {list:()=>saved?[saved]:[],initialize:({projectId,agentId})=>(saved={id:'s1',projectId,agentId,status:'auth_required'}),get:()=>saved,snapshot:()=>({session:saved,events:[]}),action:async()=>({session:saved})};}`);
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
 const cross=request({action:'message'},owner.cookie);cross.headers.set('origin','https://other.example');
 assert.equal((await detail.POST(cross,ctx)).status,403);
 fixture.getDatabase().prepare('DELETE FROM project_membership WHERE user_id=?').run(member.id);
 assert.equal((await detail.GET(request(null,member.cookie),ctx)).status,403);
 assert.equal((await detail.POST(request({action:'message'},member.cookie),ctx)).status,403);
});
