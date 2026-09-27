import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { browserLoginCallbackPort, loginMethod, parseBrowserLoginStart } from '../lib/codex-login.mjs';
import { createCodexSessionService } from '../lib/codex-sessions.mjs';

// HAC-161: ChatGPT browser sign-in. The authorize URL shape matches codex-rs/login
// build_authorize_url (rust-v0.157.1); state and PKCE values here are fake.
const authUrl = (redirect = 'http://localhost:1455/auth/callback', origin = 'https://auth.openai.com') =>
  `${origin}/oauth/authorize?response_type=code&client_id=app_test&redirect_uri=${encodeURIComponent(redirect)}` +
  '&scope=openid+profile&code_challenge=fake-challenge&code_challenge_method=S256&state=fake-state&codex_cli_simplified_flow=true';
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('accepts the Codex authorize URL for the default and fallback callback ports', () => {
  assert.equal(browserLoginCallbackPort(authUrl()), 1455);
  assert.equal(browserLoginCallbackPort(authUrl('http://localhost:1457/auth/callback')), 1457);
  assert.deepEqual(parseBrowserLoginStart({ type: 'chatgpt', loginId: '5d1c-uuid', authUrl: authUrl() }),
    { method: 'browser', authUrl: authUrl(), callbackPort: 1455, loginId: '5d1c-uuid' });
});

test('rejects other hosts, schemes, ports, paths and redirect targets', () => {
  const rejected = [
    authUrl(undefined, 'https://auth.openai.com.evil.test'),
    authUrl(undefined, 'http://auth.openai.com'),
    authUrl(undefined, 'https://openai.com'),
    authUrl().replace('https://', 'https://user:pass@'),
    authUrl('http://localhost:8080/auth/callback'),
    authUrl('http://localhost:1456/auth/callback'),
    authUrl('http://127.0.0.1:1455/auth/callback'),
    authUrl('https://localhost:1455/auth/callback'),
    authUrl('http://localhost:1455/auth/callback/../../steal'),
    authUrl('http://localhost:1455/other'),
    authUrl('http://localhost:1455/auth/callback?x=1'),
    authUrl('http://evil.test:1455/auth/callback'),
    authUrl('http://localhost@evil.test:1455/auth/callback'),
    'https://auth.openai.com/oauth/authorize?state=x',
    `${authUrl()}&redirect_uri=${encodeURIComponent('http://localhost:1457/auth/callback')}`,
    `${authUrl()}${'a'.repeat(5000)}`,
    'not a url', 42, null,
  ];
  for (const value of rejected) assert.equal(browserLoginCallbackPort(value), null, String(value).slice(0, 120));
  assert.throws(() => parseBrowserLoginStart({ type: 'chatgptDeviceCode', loginId: 'x', authUrl: authUrl() }));
  assert.throws(() => parseBrowserLoginStart({ type: 'chatgpt', loginId: 'bad id!', authUrl: authUrl() }));
  assert.throws(() => parseBrowserLoginStart({ type: 'chatgpt', loginId: 'x', authUrl: authUrl('http://localhost:9999/auth/callback') }), /cannot use/);
});

test('login method defaults to device code for API compatibility', () => {
  assert.equal(loginMethod(undefined), 'deviceCode');
  assert.equal(loginMethod('deviceCode'), 'deviceCode');
  assert.equal(loginMethod('browser'), 'browser');
  assert.equal(loginMethod('password'), null);
});

function fixture({ start } = {}) {
  const db = new Database(':memory:');
  let callbacks; const calls = [];
  const runtime = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') return { account: null };
      if (method === 'thread/start') return { thread: { id: 'thread-1', turns: [] } };
      if (method === 'account/login/start') {
        if (params.type === 'chatgptDeviceCode') return { type: 'chatgptDeviceCode', loginId: 'device-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
        return start ? start(calls.length) : { type: 'chatgpt', loginId: `login-${calls.length}`, authUrl: authUrl() };
      }
      if (method === 'account/login/cancel') return { status: 'canceled' };
      return {};
    }, close() {}, async stop() {},
  };
  const service = createCodexSessionService({ db, dataDir: '/tmp/codex-login-test', sweepMs: 0,
    runtimeFactory: async (options) => { callbacks = options; return runtime; } });
  return { db, service, calls, notify: (m, p) => callbacks.onNotification(m, p) };
}

test('browser login returns the URL and port, is never saved, and cancel is explicit and idempotent', async () => {
  const f = fixture();
  const { id } = f.service.initialize({ projectId: 'p', agentId: 'a', createdBy: 'u' });
  await tick();
  assert.equal(f.service.get(id).status, 'auth_required');
  assert.deepEqual(await f.service.action(id, { action: 'cancelLogin' }), { session: f.service.get(id), cancelled: false });

  const { login } = await f.service.action(id, { action: 'login', method: 'browser' });
  assert.equal(login.method, 'browser');
  assert.equal(login.callbackPort, 1455);
  assert.match(login.authUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.deepEqual(f.calls.find((c) => c.method === 'account/login/start').params, { type: 'chatgpt' });
  const saved = JSON.stringify(f.service.snapshot(id)) + JSON.stringify(f.db.prepare('SELECT * FROM codex_session_event').all());
  assert.equal(saved.includes('fake-state'), false);
  assert.equal(saved.includes('fake-challenge'), false);

  // A second start cancels the first attempt before starting another.
  const second = (await f.service.action(id, { action: 'login', method: 'browser' })).login;
  assert.notEqual(second.loginId, login.loginId);
  assert.deepEqual(f.calls.filter((c) => c.method === 'account/login/cancel').map((c) => c.params), [{ loginId: login.loginId }]);
  // Codex reports the cancelled attempt as a failed completion: no error is shown.
  f.notify('account/login/completed', { loginId: login.loginId, success: false, error: 'Login cancelled' });
  assert.equal(f.service.get(id).error, null);

  const cancelled = await f.service.action(id, { action: 'cancelLogin' });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(f.calls.filter((c) => c.method === 'account/login/cancel').at(-1).params, { loginId: second.loginId });
  f.notify('account/login/completed', { loginId: second.loginId, success: false, error: 'Login cancelled' });
  assert.equal(f.service.get(id).status, 'auth_required');
  assert.equal(f.service.get(id).error, null);
  assert.equal((await f.service.action(id, { action: 'cancelLogin' })).cancelled, false);

  // A real failure (not cancelled) still reports that sign-in did not complete.
  const third = (await f.service.action(id, { action: 'login', method: 'browser' })).login;
  f.notify('account/login/completed', { loginId: third.loginId, success: false, error: 'denied' });
  assert.match(f.service.get(id).error, /did not complete/);
  f.service.close(); f.db.close();
});

test('device code stays the default login method', async () => {
  const f = fixture();
  const { id } = f.service.initialize({ projectId: 'p', agentId: 'a', createdBy: 'u' });
  await tick();
  const { login } = await f.service.action(id, { action: 'login' });
  assert.deepEqual(login, { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
  await assert.rejects(f.service.action(id, { action: 'login', method: 'password' }), (error) => error.status === 400);
  f.service.close(); f.db.close();
});

test('an unusable browser authorize URL is refused without echoing it', async () => {
  const f = fixture({ start: () => ({ type: 'chatgpt', loginId: 'l1', authUrl: authUrl('http://localhost:4444/auth/callback') }) });
  const { id } = f.service.initialize({ projectId: 'p', agentId: 'a', createdBy: 'u' });
  await tick();
  await assert.rejects(f.service.action(id, { action: 'login', method: 'browser' }),
    (error) => error.status === 502 && !error.message.includes('4444') && /cannot use/.test(error.message));
  assert.equal((await f.service.action(id, { action: 'cancelLogin' })).cancelled, false);
  f.service.close(); f.db.close();
});
