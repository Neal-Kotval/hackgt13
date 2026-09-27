# alto desktop

The desktop shell provides **Project chat** and **Environments**. The Tasks section and desktop task authoring were removed in HAC-154; existing backend task records and APIs remain intact.

## Install and launch

Use Node.js 22 and a reachable web app. Run `just desktop-setup`, then `just desktop`. `just desktop-devtools` opens DevTools. Renderer changes hot reload; main-process changes require restarting Electron. The website owns environment setup. Select a ready environment in Project chat and sign Codex in there; see [environment testing](../LOCAL_CODEX.md).

## Project chat

- Choose a project and a ready environment. Codex executes over that environment's verified SSH connection, using the same device key, pinned host key, workspace and agent-run recording as Environments. Docker testing uses this same path; there is no local-agent setup or separate local chat transport.
- **New chat** opens environment selection. Returning to an opened environment retains its in-memory transcript, draft and attachments. Search opened conversations with **Cmd/Ctrl+K**. Conversation state does not survive desktop relaunch; recorded runs remain available on the web and workspace files stay in the environment until teardown. Old `/api/codex-sessions` test history and legacy `threads.json` files are preserved but not migrated or shown here.
- Enter sends, Shift+Enter adds a line, and IME composition does not send early. Stop requests termination of the remote process and reports whether that was verified. Failed submissions retain the draft; the UI never automatically retries a prompt.
- Attach up to eight text files under 16 KB each. Contents are sent as context; the total message is limited to 16,000 characters.
- Replies retain Markdown/code formatting and real command/file evidence. Each prompt runs a separate `codex exec`; a bounded summary of the last six turns provides follow-up context. This is not a persistent Codex thread.
- Sign-in, export and execution all target the selected environment. The optional **Use this Mac's Codex login** copies credentials to that environment; it does not execute Codex locally. Trusted shell access remains explicit. Environment selection and sign-out are blocked during a run or device sign-in.
- **Terminal** opens the selected environment's SSH terminal. **Open chat** in Environments returns to Project chat rather than opening a second agent UI.

## Deep links

The existing `agentcloud://` scheme is retained for compatibility. `projectId` selects Project chat. `runBoxId` and legacy `taskRunBoxId` select an environment conversation after its ready/SSH check. Legacy `codexSessionId` links show a notice and require explicit environment selection. Legacy `environmentId` links open Environments with a notice because catalog resource IDs are not run-box IDs. Unavailable project/session IDs do not silently select another conversation.

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
- **Deep link.** `agentcloud://open?projectId=<id>&runBoxId=<jobId>` opens Project chat once the listing reports the job `ready` and publishes SSH access. Host or port values in the URL are ignored. The legacy `environmentId` form opens Environments with a notice; catalog resource IDs are not run-box IDs.
- **Access model.** SSH is trusted shell access to the environment. It is not a filesystem or command sandbox.
- **Limitation.** Keys registered after an environment was allocated are not on that environment; create a new environment.

`npm test` includes an sshd integration test (`tests/ssh-integration.test.ts`) that builds a throwaway `alpine` + `openssh` image, connects with a generated device key and the container's real host key, runs `whoami`, and checks that a wrong pinned key and an unauthorized key are refused. It skips when Docker is unavailable; set `AGENTCLOUD_SKIP_DOCKER_TESTS=1` to skip it explicitly.

## Codex panel (HAC-122)

**Open chat** on a ready environment opens Project chat. Everything runs in the main process over the same pinned host key and device key as the terminal (`electron/codex-*.ts`); the renderer (`src/components/CodexPanel.tsx`) only receives statuses and run events.

- **Sign-in.** Primary: **Sign in with ChatGPT** runs `codex login --device-auth` in the environment and shows the link (opened in the system browser) and a copyable one-time code. Secondary: **Use this Mac's Codex login** copies `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) into the box over SSH stdin as a 0600 file. It may sign out Codex on this Mac; the token is copied to the box and removed at teardown (HAC-121 cleanup). The file contents never cross IPC and are never logged. Before either login the box's `~/.codex/config.toml` is set to `cli_auth_credentials_store = "file"`.
- **Run.** Each prompt runs `codex exec --json --ephemeral --skip-git-repo-check -s danger-full-access -C <workspacePath> -- <prompt>` (workspace from the run-box listing, else `~`). The prompt is passed as a single-quoted positional argument, never spliced into shell text, and stdin is `/dev/null`. JSONL events stream into the transcript: messages, collapsed reasoning, commands with exit codes and bounded output, file changes. Follow-ups are new ephemeral runs that carry a bounded summary of earlier prompts and replies; workspace files persist between runs.
- **Stop** sends TERM, then KILL, to the remote process group and reports whether it confirmed the group is gone.
- **Export changes** saves `git status` (as `#` comments), `git diff HEAD` and untracked files as new-file diffs to a `.patch` via a save dialog. The workspace is not modified.
- **Recording.** Runs are posted to `/api/agent-runs` (HAC-124). If the server lacks the route, the run still works and the panel says "Not recorded". **View on web** opens `/projects/<id>/runs?run=<runId>` on `AGENTCLOUD_URL` only.
- **Trusted shell access.** Codex's sandbox is off inside the box; the environment is the boundary.
- **Mount point.** `ProjectChat` renders the environment-backed `CodexPanel` transport through the shared chat composer and transcript. `EnvironmentsPanel` routes its Open chat action there.

Tests: `tests/codex-events.test.ts` (parser, recorded fixtures), `tests/codex-remote.test.ts` (quoting through a real bash, config merge), `tests/codex-session.test.ts` (recording, 404 tolerance, stop, auth file never returned), and `tests/codex-integration.test.ts` (Docker: real Codex 0.157.1 status and device-code output, a fake `codex` for streaming and process-group stop, and patch export; skips without Docker).

### Using a local server on another port

Set `AGENTCLOUD_URL=http://127.0.0.1:3010` in `desktop/.env` (or the shell) before `just desktop`. Plain `http` on loopback works because API calls run in the main process. A saved session keeps the origin it signed in against, so sign out and relaunch when switching servers.

## Verification and design

`just desktop-verify` runs TypeScript, token checks, tests, and the production build. `npm run test:chat:browser --prefix desktop` runs isolated headless Playwright checks at 375, 768, and 1440 pixels and writes screenshots under `artifacts/hac-154/`. The fixture is test-only and does not seed application data. Docker SSH tests skip when Docker is unavailable.

The renderer consumes `app/tokens.css`, shared fonts, and the web Select primitive. The supplied design reference is preserved in `reference/desktop-project-chat/`; its Tasks navigation is intentionally omitted. Search and history live in the shared sidebar, with a focus-managed drawer on narrow windows. Empty conversations use centered context chips; active conversations use an uncluttered reading column, user bubbles, unboxed assistant turns, and a context toolbar in the composer. Errors and actual execution status remain visible.

This local Docker/SSH client does not prove AWS allocation, GPU execution, or public tenant isolation. Desktop is not notarized or packaged for distribution.
