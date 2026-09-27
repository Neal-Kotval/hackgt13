# alto desktop

The desktop shell provides **Project chat** and **Environments**. The Tasks section and desktop task authoring were removed in HAC-154; existing backend task records and APIs remain intact.

## Install and launch

Use Node.js 22 and a reachable web app. Run `just desktop-setup`, then `just desktop`. `just desktop-devtools` opens DevTools. Renderer changes hot reload; main-process changes require restarting Electron. The website owns Codex initialization and authentication through project Settings; see [local Codex setup](../LOCAL_CODEX.md).

## Project chat

- Choose a project and agent using the context controls. **New chat** opens context selection; selecting an agent resumes its server conversation. The current API has one persistent session per project/agent and no separate create/delete conversation operation.
- Search history with **Cmd/Ctrl+K**. Conversations are grouped by local calendar date. Titles come from actual first messages when loaded, with agent names as fallbacks.
- Enter sends, Shift+Enter adds a line, and IME composition does not send early. Stop interrupts the selected session. Reconnect resumes stopped sessions.
- Attach up to eight text files, each under 16 KB. Their contents are included in the message, not uploaded as separate files. Message plus context is limited to 16,000 characters. Drafts and attachments stay in memory per conversation and do not survive relaunch.
- Assistant Markdown supports highlighted code and copy actions. Command disclosures show the server's redacted summaries. Raw command output, file diffs, and handoffs are not invented; optional rich items render only when supplied by the backend.
- Retry resends the preceding user message. A lost response retains its request ID; ambiguous turns require explicit **Send as a new turn** recovery. Unrelated unsent drafts are preserved.
- **Local Docker** describes Codex execution. Ready run boxes labeled **SSH terminal** open a separate terminal; choosing one does not relocate the Codex session.

History is loaded from authenticated server snapshots. Legacy `threads.json` storage and compatibility `/api/chat` transport remain intact but are not displayed or migrated into Codex history. Electron does not hold model API keys.

## Deep links

The existing `agentcloud://` scheme is retained for compatibility. `projectId` and `codexSessionId` select Project chat. `runBoxId` and legacy `taskRunBoxId` open the environment terminal. Legacy `environmentId` links open Environments with a notice because catalog resource IDs are not run-box IDs. Unavailable project/session IDs do not silently select another conversation.

An optional `serverUrl` must match the configured authenticated origin. A mismatch shows an error; desktop never sends credentials or requests to the link's origin. Technical environment variables, package IDs, storage paths, and protocol names retain their existing names despite the lowercase alto display brand.

## Employee authentication (HAC-24)

Desktop reuses the web app’s Better Auth employee accounts and session cookies. There is no parallel password store.

1. Start the web app (`just` / `just dev`) and create/verify an account there if needed.
2. Set `AGENTCLOUD_URL` in `desktop/.env` if the web origin is not `http://127.0.0.1:3000`.
   For the shared AWS app, run `doppler setup --no-interactive` in the repository root, then `just desktop-doppler`. The shared Doppler `dev` config supplies `AGENTCLOUD_URL`; no AWS credentials or local web server are needed for this path. Environment variables supplied by Doppler take precedence over `desktop/.env`.
3. Launch desktop (`just desktop`) and sign in with that email/password.
4. Human API calls from the desktop bridge send the session cookie only — never an agent `Authorization: Bearer` token.
5. Unauthenticated calls to protected routes such as `/api/state` receive **401**.
6. Session cookies live under Electron `userData/auth/` (OS keychain-backed encryption via `safeStorage` when available). They are **never** written into `threads.json` or chat transcripts.

Agent CLI tokens remain separate and only work on `/api/agent`.

## Environments and in-app SSH terminal (HAC-90)

Follows [docs/sandbox-mvp-contract.md](../docs/sandbox-mvp-contract.md).

- **Device key.** After sign-in (and on launch with a valid session) the main process ensures one ed25519 keypair per device (`electron/device-key.ts`). It is generated with Node `crypto`, stored as an OpenSSH private key encrypted with `safeStorage` under `userData/ssh/device-ssh-key.bin`, and registered with `POST /api/ssh-keys { label: <hostname>, publicKey }`. The private key never crosses IPC and is never logged. If OS encryption is unavailable the key is kept in memory for that run only (not written to disk). The Environments view shows the key fingerprint and registration state.
- **Environments view.** Pick a project; the list shows each run box's server state (queued, allocating, connecting, verifying SSH, ready, stopping, stopped, failed), provider/profile, and a **Trusted shell access** label. **Open terminal** is enabled only when the state is `ready`, the listing includes `ssh`, and no stop was requested. The list polls every 5 s while any job is in flight. Desktop does not create or stop environments.
- **Terminal.** `terminal:open` fetches `GET /api/run-boxes/:id/connection` with the employee session, then connects with `ssh2` using the API's host, port, and username and the device key. The presented host key must equal `hostPublicKey` exactly (only `ssh-ed25519` is negotiated); otherwise the connection fails with “Host key does not match the pinned key for this environment”. A `403 { code: "no_authorized_key" }` explains that the device key was registered after the environment was created. Sessions are owned by the window that opened them and are closed when it reloads, closes, or the app quits. The xterm theme is read from the design tokens at runtime.
- **Deep link.** `agentcloud://open?projectId=<id>&runBoxId=<jobId>` opens Project chat and attaches the SSH terminal once the listing reports the job `ready`. Host or port values in the URL are ignored. The legacy `environmentId` form opens Environments with a notice; catalog resource IDs are not run-box IDs.
- **Access model.** SSH is trusted shell access to the environment. It is not a filesystem or command sandbox.
- **Limitation.** Keys registered after an environment was allocated are not on that environment; create a new environment.

`npm test` includes an sshd integration test (`tests/ssh-integration.test.ts`) that builds a throwaway `alpine` + `openssh` image, connects with a generated device key and the container's real host key, runs `whoami`, and checks that a wrong pinned key and an unauthorized key are refused. It skips when Docker is unavailable; set `AGENTCLOUD_SKIP_DOCKER_TESTS=1` to skip it explicitly.

### Using a local server on another port

Set `AGENTCLOUD_URL=http://127.0.0.1:3010` in `desktop/.env` (or the shell) before `just desktop`. Plain `http` on loopback works because API calls run in the main process. A saved session keeps the origin it signed in against, so sign out and relaunch when switching servers.

## Verification and design

`just desktop-verify` runs TypeScript, token checks, tests, and the production build. `npm run test:chat:browser --prefix desktop` runs isolated headless Playwright checks at 375, 768, and 1440 pixels and writes screenshots under `artifacts/hac-154/`. The fixture is test-only and does not seed application data. Docker SSH tests skip when Docker is unavailable.

The renderer consumes `app/tokens.css`, shared fonts, and the web Select primitive. The supplied design reference is preserved in `reference/desktop-project-chat/`; its Tasks navigation is intentionally omitted. Search and history live in the shared sidebar, with a focus-managed drawer on narrow windows. Empty conversations use centered context chips; active conversations use an uncluttered reading column, user bubbles, unboxed assistant turns, and a context toolbar in the composer. Errors and actual execution status remain visible.

This local Docker/SSH client does not prove AWS allocation, GPU execution, or public tenant isolation. Desktop is not notarized or packaged for distribution.
