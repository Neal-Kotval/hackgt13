// Isolated renderer fixture only: exercises the existing environment IPC contract.
(() => {
  const box = (id, projectId, state = 'ready') => ({ id, projectId, provider: 'docker-local', profileId: id === 'box-1' ? 'cpu-workspace-with-a-long-environment-name' : id, state, rawState: state, ssh: state === 'ready' ? { host: '127.0.0.1', port: 2222, username: 'test' } : null, stopRequested: false });
  const state = { projects: [{ id: 'p1', name: 'UI verification', agents: [], tasks: [], resources: [], resourceRequests: [] }, { id: 'p2', name: 'Second project', agents: [], tasks: [], resources: [], resourceRequests: [] }] };
  const test = window.__test = { state, boxes: [box('box-1','p1'), box('box-2','p1'), box('box-failed','p1','failed')], sends: [], fail: false, hold: false, signedIn: true, listeners: [], deepLink: null, emit: event => test.listeners.forEach(handler => handler(event)) };
  window.agentcloudDesktop = {
    authStatus: async () => ({ signedIn: true, baseUrl: 'http://127.0.0.1:3000', user: { id: 'test', name: 'UI test', email: 'test@example.invalid' }, secureStorage: true }),
    signOut: async () => ({ signedIn: false, baseUrl: 'http://127.0.0.1:3000', secureStorage: true }),
    onDeepLink: cb => { test.deepLink = cb; return () => {}; }, takePendingDeepLink: async () => null,
    getState: async () => structuredClone(state), listRunBoxes: async id => structuredClone(test.boxes.filter(box => box.projectId === id)),
    fetchHuman: async () => { throw Error('Legacy local-agent API must not be called'); },
    onTerminalEvent: () => () => {}, terminalOpen: async () => { throw Error('Test SSH unavailable'); }, terminalWrite: () => {}, terminalResize: () => {}, terminalClose: async () => {}, deviceKeyStatus: async () => ({ state: 'registered', message: 'Test device', fingerprint: 'test', persistent: true }),
  };
  window.agentcloudCodex = {
    status: async () => ({ signedIn: test.signedIn, detail: test.signedIn ? 'Signed in' : 'Sign-in required', localLoginAvailable: false }),
    login: async id => { test.emit({ type: 'device-code', sessionId: 'login', runBoxId: id, url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' }); return { sessionId: 'login' }; },
    onEvent: handler => { test.listeners.push(handler); return () => { test.listeners = test.listeners.filter(item => item !== handler); }; },
    run: async (id, prompt, options) => {
      test.sends.push({ id, prompt, options });
      if (test.fail) throw Error('Test SSH connection unavailable');
      const sessionId = 'run-' + test.sends.length;
      const event = (seq, kind, text, extra = {}) => ({ sessionId, runId: sessionId, seq, kind, actor: kind === 'message' && seq === 1 ? 'employee' : 'codex', text, at: new Date().toISOString(), ...extra });
      // Deliberately arrive before run() resolves to exercise buffered IPC events.
      test.emit(event(1, 'message', options.recordPrompt));
      test.emit(event(2, 'command.start', '', { command: 'printf ready' }));
      test.emit(event(3, 'command.output', 'ready', { command: 'printf ready' }));
      test.emit(event(4, 'command.exit', '', { command: 'printf ready', exitCode: 0 }));
      test.emit(event(5, 'message', '**Environment reply**\n\n```ts\nconst result = "ready";\n```'));
      if (!test.hold) test.emit({ type: 'run-finished', sessionId, runId: sessionId, status: 'succeeded', exitCode: 0, recorded: true });
      return { sessionId, runId: sessionId, recorded: true, workspacePath: '/workspace' };
    },
    stop: async sessionId => { test.emit({ type: 'run-finished', sessionId, runId: sessionId, status: 'cancelled', exitCode: null, stopVerified: true, recorded: true }); return { stopped: true, verified: true }; },
    exportChanges: async () => ({ savedTo: null, reason: 'no-changes' }), openDeviceUrl: async () => {}, openRunOnWeb: async () => {},
  };
})();
