# Stage 3 contract: Codex app-server sessions on remote environments (HAC-153)

Status: in progress. This extends main's server-side Codex sessions (`lib/codex-sessions.mjs`, `lib/codex-docker.mjs`, Project chat) so a session can run Codex on a remote environment (a run box) instead of only in local Docker. It builds on Stage 2 (`docs/stage2-contract.md`): every environment has Codex 0.157.1, a pinned host key and a recorded `workspacePath`.

Decisions:
- **Protocol:** `codex app-server` (JSON-RPC over stdio), the same protocol and client for local Docker and SSH.
- **Sign-in:** ChatGPT through the protocol, surfaced in the desktop app. For environments the default is browser sign-in (`account/login/start {type: "chatgpt"}`) with the OAuth callback tunneled from the Mac over SSH (HAC-161, see [ChatGPT browser sign-in](#chatgpt-browser-sign-in-hac-161)); device code (`{type: "chatgptDeviceCode"}`) remains the API default and the fallback. Usage bills to the employee's ChatGPT plan. The owner has ChatGPT Pro, so there is no access-token path (access tokens are Business/Enterprise only).
- **Who opens SSH:** the backend runs Codex. The desktop only calls the session API, except for the short-lived sign-in callback tunnel (HAC-161), which uses the desktop's own terminal trust path.

## Session target

`codex_session` gains `run_box_id TEXT NULL`: null means local Docker, as today. The canonical setup session is unique per `(project_id, agent_id, run_box_id)`; explicit chats may share that target (HAC-164).

```
POST /api/codex-sessions { projectId, agentId, runBoxId? }  -> 202 { session }
```

- With `runBoxId`, the environment must be in the same project, `ready`, with `agent.codex.state === "ready"`; otherwise 409 with a reason.
- Owner-only, as today.
- `GET /api/codex-sessions?projectId=` returns each session with `target: { kind: "local" } | { kind: "runBox", runBoxId, provider, profileId, state }`.
- All other routes (turns, interrupt, login, snapshot) are unchanged. They act on whichever target the session has.

## Runtimes

- `lib/codex-rpc.mjs` (new): the JSON-RPC stdio client extracted from `createCodexDockerRuntime`, unchanged in behavior. That covers the 2 MiB frame limit, answering server requests with a decline or not-supported error, never passing on server error text, and the EOF-then-kill shutdown. `codex-docker.mjs` uses it.
- `lib/codex-ssh.mjs` (new): `createCodexSshRuntime({ sessionId, runBoxId, onNotification, onExit })` runs the system `ssh`:
  ```
  ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile=<temp 0600 file from run_box_ssh_endpoint> -i <server key> -p <port> \
      agentcloud@<host> 'cd <workspacePath> && exec codex app-server'
  ```
  - The pinned known_hosts file is written from `run_box_ssh_endpoint` and deleted when the runtime closes.
  - A host-key mismatch or refused key maps to a clear session error.
  - Stop and close use the shared client's EOF-then-kill sequence.
- `lib/codex-service.ts` picks the runtime per session: `run_box_id ? createCodexSshRuntime : createCodexDockerRuntime`. `AGENTCLOUD_CODEX_ENABLED=1` gates local Docker only; remote sessions need a ready environment.

## Server SSH identity

- `lib/codex-runner-key.mjs` (new): one ed25519 key per install at `<AGENTCLOUD_DATA_DIR>/codex-runner/id_ed25519`. The directory is 0700 and the files 0600. It's generated with `ssh-keygen` on first use and never logged or returned by any API.
- At allocation, every provider (docker-local, runpod, aws-cpu) adds this public key to the environment's `agentcloud` authorized keys, next to the members' device keys. Its fingerprint is recorded in `run_box_ssh_endpoint.authorized_fingerprints`, tagged as the server key. Environments created before this change don't have it, so a remote session reports "Create a new environment to use Codex on it."

## Website preparation and desktop chats (HAC-164)

The website prepares the environment's canonical session and owns Codex sign-in.
Use the existing owner-only initialization route above, then
`POST /api/codex-sessions/:id {action:"login",method:"deviceCode"}` when it reports
`auth_required`. Device sign-in needs no callback tunnel on the user's computer.
Only a `ready` or `running` session confirms account authentication; machine or CLI
readiness alone does not. The desktop handoff selects that environment and its
existing history. Standalone local boxes are retained only for compatibility.

```
POST /api/codex-sessions
  {projectId, agentId, runBoxId, newChat:true, requestId:<UUID>}
  -> 202 {session}
```

- Project members may create independent chats on an environment with at least one
  authenticated `ready`/`running` session in the same project. Otherwise the server
  returns 409 with `code:"environment_setup_required"`; the UI sends the user to
  website setup. Each new runtime independently reads the actual account before
  becoming ready, so expired credentials can still produce `auth_required`.
- The request ID is scoped to the employee. Retrying the same target/agent/request
  returns the saved chat; reusing it for another target or agent returns 409.
  Creating chats for a null/local target is rejected. A fresh request ID creates
  a distinct Codex thread, events and turn idempotency namespace.
- Default initialization remains owner-only and always returns the canonical
  setup session, even after several chats exist. Existing rows migrate to canonical
  setup sessions, preserving IDs, threads, events and turn request records.
- List and detail DTOs include `isSetupSession:boolean` and `title:string`.
  A title is the first user message with whitespace normalized, redacted and
  bounded to 80 characters (or `"New chat"` until the first message). The title
  persists independently of bounded event-history pruning.
- Desktop environment selection reads existing sessions; explicit **New chat**
  performs the POST. Chats share workspace files and the environment account;
  separate histories are not isolated filesystems or separate OpenAI identities.
- Members can message, interrupt and resume independent environment chats. Owners
  alone can initialize/resume canonical setup sessions, sign in, cancel sign-in
  or stop sessions. Resuming uses the saved thread ID, never silently replaces a
  nonempty conversation. On backend restart the old connection is marked ended;
  reopening an existing independent chat can re-check the account and reconnect.
- `agentcloud://open?projectId&runBoxId&codexSessionId` selects the environment and
  optional saved chat in desktop. Legacy links remain compatible. The browser
  login API below remains available for existing clients; product setup uses the
  website device flow.

## ChatGPT browser sign-in (HAC-161)

Verified against openai/codex `rust-v0.157.1`: `account/login/start {type: "chatgpt"}` returns `{type: "chatgpt", loginId, authUrl}`. Codex's login server (`codex-rs/login/src/server.rs`) binds `127.0.0.1:1455` (`DEFAULT_PORT`), falling back to `127.0.0.1:1457` (`FALLBACK_PORT`) when 1455 stays busy, and puts `redirect_uri=http://localhost:<port>/auth/callback` in the authorize URL. `account/login/cancel {loginId}` stops it; `account/login/completed {loginId, success, error}` reports the result. AgentCloud does not set `useHostedLoginSuccessPage` (it redirects to a Codex-app page) or `codexStreamlinedLogin`; Codex serves its own local success page through the tunnel.

```
POST /api/codex-sessions/:id { action: "login", method: "browser" }
  -> { session, login: { method: "browser", authUrl, callbackPort, loginId } }
POST /api/codex-sessions/:id { action: "login" }          # or method: "deviceCode"; unchanged
  -> { session, login: { verificationUrl, userCode } }
POST /api/codex-sessions/:id { action: "cancelLogin" }
  -> { session, cancelled: true | false }
```

- Owner-only, like the other setup actions. An unknown `method` is 400.
- `authUrl` must be `https://auth.openai.com` (no userinfo) with exactly one `redirect_uri` equal to `http://localhost:<port>/auth/callback`, `port` in {1455, 1457}. Anything else is 502 "Codex returned a sign-in address AgentCloud cannot use." (`lib/codex-login.mjs`).
- The authorize URL carries the OAuth state and PKCE challenge. It is returned to the owner who asked and is never stored in session events, the database or logs. Only the pending `loginId` is kept, in memory.
- One login per session: a new start (browser or device) cancels the pending one. `cancelLogin` is idempotent; a cancelled attempt's failed `account/login/completed` does not set a session error. A real failure still reports "Codex sign-in did not complete."
- **Desktop tunnel** (`desktop/electron/codex-login-tunnel.ts`): after the login route answers, the renderer asks main to start the tunnel. Main re-validates the URL and port, listens on `127.0.0.1:<port>` only (fails with "Port 1455 on this Mac is in use (is another Codex sign-in running?)…" when busy), fetches `GET /api/run-boxes/:id/connection`, connects with `ssh2` using the pinned host key and the device key, and forwards each accepted connection with `direct-tcpip` to `127.0.0.1:<port>` on the environment. Only then does it `shell.openExternal(authUrl)`. It closes when the session leaves `auth_required`, on Cancel, window close or reload, sign-out, quit, or after 10 minutes, and tells the renderer when it closes on its own (timeout or SSH drop) so the renderer cancels the login.
- **Requirements and limits.** The environment's sshd must allow TCP forwarding (OpenSSH's default; AgentCloud's sandbox `sshd_config` and aws-cpu drop-in do not disable it, and forwarding has been verified only on docker-local; aws-cpu and RunPod base images are unverified). A refused forward shows "The environment refused to forward the sign-in callback. Use a device code instead.". The employee's device key must be on the environment (`403 no_authorized_key` otherwise, same as the terminal). Only one browser sign-in per port can run on a Mac at a time; a local `codex login` holding 1455 blocks it. The local Docker target keeps device code. Completing a real sign-in through the tunnel has not been automated; the integration test stops at a request to Codex's callback server.

## Cleanup

- Stage 2 teardown already removes `~/.codex/auth.json` from the box.
- Closing a remote session ends the SSH process and deletes its temporary known_hosts file.
- Stopping an environment closes any sessions targeting it and marks them `error` with "Environment stopped".

## Backend implementation notes (HAC-153)

Implemented and covered by `tests/codex-rpc.test.mjs`, `codex-ssh.test.mjs`, `codex-session-targets.test.mjs`, `codex-runner-key.test.mjs` and the real-Docker `codex-remote.integration.test.mjs`. The AWS CPU acceptance run below has not been performed.

- **Server fingerprint representation.** `run_box_ssh_endpoint.authorized_fingerprints` stays a JSON array. Member device fingerprints are stored as before; the runner key is appended as `"server:SHA256:…"`. `getRunBoxSshEndpoint` returns `authorizedFingerprints` (members only, so the connection API and access reconcilers behave as before) and `serverFingerprint` (or `null`). Runpod and aws-cpu keep the same tag (`server: true`) in their allocation-time key lists.
- **Worker wiring.** Workers take the runner key as `runnerKey` (`{ publicKey, fingerprint }`); `scripts/run-box-worker.mjs` supplies it from `getCodexRunnerKey()`. Access reconcilers keep the runner key while it is still this install's key; otherwise they remove it and clear `serverFingerprint`.
- **Session API.** `POST /api/codex-sessions` accepts `runBoxId` (string, `[A-Za-z0-9-]{1,64}`; 400 otherwise). Validation failures return 409 with one of: `Environment not found in this project.`, `The environment must be ready to run Codex.`, `Codex is not ready on this environment.`, `The environment has no recorded workspace.`, `Create a new environment to use Codex on it.` Sessions also keep `provider` (`docker-local` for local, the job's provider for remote). `GET` lists all sessions; `enabled` still reports whether local Docker boxes are enabled. A local `POST` while `AGENTCLOUD_CODEX_ENABLED` is unset returns 503.
- **Remote session behavior.** `stop` closes the SSH transport and marks the session `stopped`; it never stops or changes the environment. `resume` refuses once the environment is no longer ready. The operator `AGENTCLOUD_CODEX_API_KEY` is never sent to an environment. Threads start with `cwd = workspacePath`. At most 16 live remote sessions per server (local boxes keep their limit of 4).
- **Session errors.** Only fixed AgentCloud messages are shown: host-key mismatch, refused server key (`… Create a new environment to use Codex on it.`), missing server key, missing Codex or workspace, unreachable host, `Environment stopped`. ssh stderr and protocol error text are never stored, returned or logged.
- **Environment stop.** `requestRunBoxStop` notifies in-process listeners, so a stop from the web API closes that environment's sessions at once. Stops made by a worker process are found by the session service's 5-second state sweep (and on every list/get). The SSH process exits through the shared EOF-then-kill sequence and its temporary known_hosts directory is removed.
- **aws-cpu gaps closed.** The aws-cpu worker now records `agent.codex` (from the Codex version it already proves) and `workspacePath`, so its environments can be session targets. It also gains member key revocation (`reconcileAwsCpuSshAccess`, HAC-132 parity; an unverifiable replacement requests a stop) and teardown cleanup of `~/.codex/auth.json` and scratch before termination (`createAwsCpuAgentCleanup`, passed to `reconcileAwsRunBoxes` as `cleanupAgent`).
- **Staging (HAC-166).** The staging app and worker share `/var/lib/agentcloud` and the `agentcloud` user, so the runner key the worker injects is the one the app's sessions use. The backend reaches aws-cpu boxes from the worker's `/32`; the desktop terminal and the HAC-161 sign-in tunnel reach them from the creator's public IPv4, captured from `CloudFront-Viewer-Address` when `AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1` (see AWS_SETUP.md, CPU environment). A later address change needs a new environment until the TODO "Refresh my SSH access" request exists.
- **Limits.** One backend process owns SSH transports; a restart marks sessions `error` and `resume` reconnects. Environments created before this change (no server fingerprint) cannot host sessions. The server key is trusted shell access as `agentcloud` on every environment this install creates.

## Acceptance

Real AWS CPU box:
- Project chat, targeting the box, signs in with a device code approved by the owner.
- A turn runs a command and writes a file in `workspacePath`, and interrupt works.
- The web Runs page and session history show it.
- Stopping the environment closes the session, the box's `auth.json` is gone before termination, and no SSH processes are left on the server.

Automated:
- Unit tests for the shared client, the SSH runtime, target selection and validation.
- A real-Docker integration test: a docker-local sandbox session over SSH, where `codex app-server` initializes and device-code start returns a URL and code (never approved).
- HAC-161: unit tests for browser login validation and cancel (`tests/codex-login.test.mjs`) and the desktop tunnel (`desktop/tests/codex-login-tunnel.test.ts`), and a real-Docker test (`desktop/tests/codex-browser-login.integration.test.ts`) where browser login start returns an auth.openai.com URL with a localhost redirect and the desktop tunnel forwards a request from the Mac-side port to Codex's callback server on the environment (then cancels; never signs in).
