import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { prepareAuth } from './auth-fixture.mjs';
import { copyRunBoxAccess } from './run-box-access-fixture.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'chat-runs-api-'));
process.env.AGENTCLOUD_DATA_DIR = path.join(dir, 'data');
await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
async function compile(source, name) {
  const code = ts.transpileModule(await readFile(new URL(source, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replaceAll('@/lib/', './').replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'");
  await writeFile(path.join(dir, name), code);
  return import(path.join(dir, name));
}
await copyFile(new URL('../lib/machine-catalog.mjs', import.meta.url), path.join(dir, 'machine-catalog.mjs'));
await compile('../lib/resource-profiles.ts', 'resource-profiles.js');
await compile('../lib/store.ts', 'store.js');
await compile('../lib/http.ts', 'http.js');
const fixture = await prepareAuth(dir);
await copyRunBoxAccess(dir);
await copyFile(new URL('../lib/chat-runs.mjs', import.meta.url), path.join(dir, 'chat-runs.mjs'));
// Real authentication and membership; no live agent or external model needed.
await writeFile(path.join(dir, 'codex-service.js'), `
import { failure } from './http.js';
import { getDatabase } from './auth.mjs';
import { createCodexSessionService, CodexSessionError } from '${new URL('../lib/codex-sessions.mjs', import.meta.url).href}';
export const codexFailure = error => error instanceof CodexSessionError ? Response.json({error:error.message},{status:error.status}) : failure(error);
export const reads = [];
const db=getDatabase();
export const instance=createCodexSessionService({db,dataDir:'unused',sweepMs:0,runtimeFactory:()=>{throw Error('must not connect');}});
const stamp='2026-09-27T01:00:00Z';
for(const [id,project,box] of [['chat','project','box'],['foreign','other-project','box2'],['local','project',null]]) {
 db.prepare('INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id) VALUES(?,?,?,?,?,?,?,?)').run(id,project,id,'owner','stopped',stamp,stamp,box);
}
for(const [id,kind,text] of [['request','user','Review my changes'],['done','status','Turn completed']]) {
 db.prepare('INSERT INTO codex_session_event(session_id,event_id,kind,text,created_at,updated_at,actor_name) VALUES(?,?,?,?,?,?,?)').run('chat',id,kind,text,stamp,stamp,'Member');
}
export function codexService() { return {...instance,list:projectId=>{reads.push(projectId);return instance.list(projectId);}}; }
`);
const route = await compile('../app/api/chat-runs/route.ts', 'route.js');
const service = await import(path.join(dir, 'codex-service.js'));
const [owner, member] = fixture.users;
fixture.grantMembership(owner.id, 'project', 'owner');
fixture.grantMembership(member.id, 'project', 'member');
function request(cookie, projectId = 'project') {
  return new Request(`http://localhost:3000/api/chat-runs?projectId=${projectId}`, { headers: cookie ? { cookie } : {} });
}
after(async () => { service.instance.close(); fixture.getDatabase().close(); await rm(dir, { recursive: true, force: true }); });

test('chat activity requires sign-in and project membership before reading snapshots', async () => {
  assert.equal((await route.GET(request())).status, 401);
  assert.equal((await route.GET(request(owner.cookie, 'other-project'))).status, 403);
  assert.equal((await route.GET(request(owner.cookie, ''))).status, 400);
  assert.deepEqual(service.reads, []);
  for (const employee of [owner, member]) {
    const response = await route.GET(request(employee.cookie));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { runs } = await response.json();
    assert.equal(runs[0].id, 'chat:request');
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].actorName, 'Member');
  }
  fixture.getDatabase().prepare('DELETE FROM project_membership WHERE user_id=?').run(member.id);
  assert.equal((await route.GET(request(member.cookie))).status, 403);
  assert.equal(service.reads.length, 2);
});

function patch(cookie, input = {}, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/api/chat-runs', {
    method: 'PATCH', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ projectId: 'project', sessionId: 'chat', status: 'in_progress', ...input }),
  });
}
test('status updates require an authorized employee, valid input and same origin', async () => {
  fixture.grantMembership(member.id, 'project', 'member');
  assert.equal((await route.PATCH(patch())).status, 401);
  assert.equal((await route.PATCH(patch(owner.cookie, {}, 'https://untrusted.example'))).status, 403);
  assert.equal((await route.PATCH(patch(owner.cookie, {projectId:'other-project'}))).status, 403);
  for (const status of ['completed', '', null, {}, 1]) {
    assert.equal((await route.PATCH(patch(owner.cookie,{status}))).status,400);
  }
  assert.equal((await route.PATCH(patch(owner.cookie,{sessionId:''}))).status,400);
  for (const sessionId of ['foreign','local','missing']) {
    assert.equal((await route.PATCH(patch(owner.cookie,{sessionId}))).status,404);
  }
  for (const [employee,status] of [[owner,'in_progress'],[member,'needs_attention']]) {
    const response=await route.PATCH(patch(employee.cookie,{status,actor:{name:'Spoofed'}}));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const result=await response.json();
    assert.equal(result.workflowStatus,status);
    assert.equal(result.workflowUpdatedBy,employee.name);
    assert.ok(result.workflowUpdatedAt);
    const {runs}=await (await route.GET(request(employee.cookie))).json();
    assert.equal(runs[0].workflowStatus,status);
    assert.equal(runs[0].status,'completed','human status does not rewrite execution outcome');
  }
  fixture.getDatabase().prepare('DELETE FROM project_membership WHERE user_id=?').run(member.id);
  assert.equal((await route.PATCH(patch(member.cookie,{status:'done'}))).status,403);
  assert.equal(service.instance.get('chat').workflowStatus,'needs_attention');
});
