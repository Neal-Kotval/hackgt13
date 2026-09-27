import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { prepareAuth } from './auth-fixture.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'environment-settings-api-'));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, 'data');
await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
for (const name of ['store', 'http', 'resource-profiles']) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  await writeFile(path.join(directory, `${name}.js`), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
for (const name of ['run-box-jobs', 'aws-organization-approval'])
  await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
const db = fixture.getDatabase();
const source = await readFile(new URL('../app/api/account/settings/route.ts', import.meta.url), 'utf8');
await writeFile(path.join(directory, 'route.js'), ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replaceAll('../../../../lib/', './').replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
const api = await import(path.join(directory, 'route.js'));
const [alice, bob] = fixture.users;
function request(method = 'GET', body, cookie = alice.cookie, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/api/account/settings', { method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

test('settings require a verified employee; mutations check origin and reject forged identities', async () => {
  assert.equal((await api.GET(request('GET', undefined, null))).status, 401);
  assert.equal((await api.PATCH(request('PATCH', { maxActiveEnvironments: 2 }, null))).status, 401);
  assert.equal((await api.PATCH(request('PATCH', { maxActiveEnvironments: 2 }, alice.cookie, 'https://evil.test'))).status, 403);
  for (const extra of [{ employeeId: bob.id }, { userId: bob.id }])
    assert.equal((await api.PATCH(request('PATCH', { maxActiveEnvironments: 2, ...extra }))).status, 400);
  db.prepare('UPDATE user SET emailVerified = 0 WHERE id = ?').run(alice.id);
  try { assert.equal((await api.GET(request())).status, 403); }
  finally { db.prepare('UPDATE user SET emailVerified = 1 WHERE id = ?').run(alice.id); }
});
test('settings persist only for the signed-in user, with strict bounds', async () => {
  assert.deepEqual(await (await api.GET(request())).json(), { maxActiveEnvironments: 1, activeEnvironments: 0 });
  for (const value of [0, 6, 1.5, '2', null])
    assert.equal((await api.PATCH(request('PATCH', { maxActiveEnvironments: value }))).status, 400);
  assert.equal((await api.PATCH(request('PATCH', {}))).status, 400);
  assert.equal((await api.PATCH(request('PATCH', { maxActiveEnvironments: 3 }))).status, 200);
  assert.equal((await (await api.GET(request())).json()).maxActiveEnvironments, 3);
  assert.equal((await (await api.GET(request('GET', undefined, bob.cookie))).json()).maxActiveEnvironments, 1);
});
