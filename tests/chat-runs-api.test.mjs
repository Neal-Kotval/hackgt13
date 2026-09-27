import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { prepareAuth } from './auth-fixture.mjs';

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
await copyFile(new URL('../lib/chat-runs.mjs', import.meta.url), path.join(dir, 'chat-runs.mjs'));
// Real authentication and membership; no live agent or external model needed.
await writeFile(path.join(dir, 'codex-service.js'), `
export { failure as codexFailure } from './http.js';
export const reads = [];
export function codexService() { return {
  list: projectId => { reads.push(projectId); return [{id:'chat',projectId,status:'ready',target:{kind:'runBox',runBoxId:'box'}}]; },
  snapshot: id => ({session:{id,projectId:'project',status:'ready',target:{kind:'runBox',runBoxId:'box'}},events:[
    {id:'request',kind:'user',text:'Review my changes',actorName:'Member',createdAt:'2026-09-27T01:00:00Z'},
    {id:'done',kind:'status',text:'Turn completed',createdAt:'2026-09-27T01:00:02Z'}
  ]})
}; }
`);
const route = await compile('../app/api/chat-runs/route.ts', 'route.js');
const service = await import(path.join(dir, 'codex-service.js'));
const [owner, member] = fixture.users;
fixture.grantMembership(owner.id, 'project', 'owner');
fixture.grantMembership(member.id, 'project', 'member');
function request(cookie, projectId = 'project') {
  return new Request(`http://localhost:3000/api/chat-runs?projectId=${projectId}`, { headers: cookie ? { cookie } : {} });
}
after(async () => { fixture.getDatabase().close(); await rm(dir, { recursive: true, force: true }); });

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
