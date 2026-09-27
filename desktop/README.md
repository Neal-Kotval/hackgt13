# alto desktop

The desktop shell provides **Project chat** and **Environments**. The Tasks section and desktop task authoring were removed in HAC-154; existing backend task records and APIs remain intact.

## Install and launch

Use Node.js 22 and a reachable web app. Run `just desktop-setup`, then `just desktop`. `just desktop-devtools` opens DevTools. Renderer changes hot reload; main-process changes require restarting Electron. The website owns Codex initialization and authentication through project Settings; see [local Codex setup](../LOCAL_CODEX.md).

## Project chat

- Set up the environment and sign in to Codex on the web Environments page first. Its desktop handoff opens that environment’s chats. Native launch lets you select an existing project/environment; unprepared environments link back to their web setup page. Desktop never provisions an environment or initiates Codex sign-in.
- **New chat** creates an independent persistent Codex thread within the selected environment using `POST /api/codex-sessions { projectId, agentId, runBoxId, newChat: true, requestId }`. The request ID is retained across retries. The backend verifies environment authentication; a setup-required response directs the user to the web flow.
- History lists only the selected environment’s chats. Titles are persisted from actual first messages by the backend. Existing remote conversations remain accessible, including conversations created before the separate-chat API. Legacy local Docker app-server sessions are excluded.
- Search history with **Cmd/Ctrl+K**. Enter sends, Shift+Enter adds a line, and IME composition does not send early. Stop interrupts the selected session; Reconnect resumes stopped chats.
- Attach up to eight text files under 16 KB each; combined message/context is limited to 16,000 characters. Drafts and attachments stay in memory per chat and do not survive relaunch. Server history survives relaunch.
- Markdown, copy, retry, ambiguous-turn recovery, origin validation, and actual server status are preserved. Docker appears only as a truthful test environment provider using the standard environment workflow.
- Native OAuth tunnel helpers from HAC-161 remain for compatibility but Project chat does not invoke or display them. Codex sign-in is handled by the web setup flow.

History is loaded from authenticated server snapshots. Legacy `threads.json` storage and compatibility `/api/chat` transport remain intact but are not displayed or migrated into Codex history. Electron does not hold model API keys.

## Deep links

The existing `agentcloud://` scheme is retained for compatibility. `projectId` and `codexSessionId` select Project chat. `agentcloud://open?projectId=…&runBoxId=…&panel=codex` opens Project chat targeting that environment's Codex; the link is queued until sign-in and the project list load, waits while the environment or its Codex check is still in progress, and never takes host or port from the URL. The Environments **Open chat** action and a `runBoxId` without a panel route the same way. Explicit `panel=terminal` and legacy `taskRunBoxId` open the environment terminal. Other `panel` values are rejected. Legacy `environmentId` links open Environments with a notice because catalog resource IDs are not run-box IDs. Unavailable project/session IDs do not silently select another conversation.

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
- **Deep link.** `agentcloud://open?projectId=<id>&runBoxId=<jobId>` opens Project chat for that environment; add `panel=terminal` to explicitly request a terminal. Host or port values in the URL are ignored. The legacy `environmentId` form opens Environments with a notice; catalog resource IDs are not run-box IDs.
- **Access model.** SSH is trusted shell access to the environment. It is not a filesystem or command sandbox.
- **Key reconciliation.** Workers reconcile registered device keys onto ready environments. A newly registered key can be unavailable until the next worker reconciliation cycle. Reconciliation requires a running provider worker.

`npm test` also runs `tests/codex-login-tunnel.test.ts` (the sign-in tunnel against an in-process ssh2 server: loopback-only listening, byte forwarding, busy port, host key and device key refusal, timeout, window close) and `tests/codex-browser-login.integration.test.ts` (real Docker: a docker-local environment, Codex app-server over SSH, browser login start, and the tunnel forwarding `GET /` from this Mac's port to Codex's callback server; the login is cancelled and never completed). The integration test skips when Docker is unavailable or when port 1455 or 1457 is already in use on this machine.

`npm test` includes an sshd integration test (`tests/ssh-integration.test.ts`) that builds a throwaway `alpine` + `openssh` image, connects with a generated device key and the container's real host key, runs `whoami`, and checks that a wrong pinned key and an unauthorized key are refused. It skips when Docker is unavailable; set `AGENTCLOUD_SKIP_DOCKER_TESTS=1` to skip it explicitly.

## One Codex UI (HAC-153)

The Stage 2 Codex panel (HAC-122) that ran `codex exec` over the desktop's own SSH connection has been removed from the Environments view, together with its main-process code (`electron/codex-*.ts`), the `agentcloudCodex` bridge and their tests. Codex on an environment now runs through Project chat and the server's `codex app-server` sessions (see [docs/stage3-contract.md](../docs/stage3-contract.md)). The "Use this Mac's Codex login" path no longer exists; sign in with ChatGPT instead.

### Using a local server on another port

Set `AGENTCLOUD_URL=http://127.0.0.1:3010` in `desktop/.env` (or the shell) before `just desktop`. Plain `http` on loopback works because API calls run in the main process. A saved session keeps the origin it signed in against, so sign out and relaunch when switching servers.

## Verification and design

`just desktop-verify` runs TypeScript, token checks, tests, and the production build. `npm run test:chat:browser --prefix desktop` runs isolated headless Playwright checks at 375, 768, and 1440 pixels and writes screenshots under `artifacts/hac-165/`. The fixture is test-only and does not seed application data. Docker SSH tests skip when Docker is unavailable.

The renderer consumes `app/tokens.css`, shared fonts, and the web Select primitive. The supplied design reference is preserved in `reference/desktop-project-chat/`; its Tasks navigation is intentionally omitted. Search and history live in the shared sidebar, with a focus-managed drawer on narrow windows. Empty conversations use centered context chips; active conversations use an uncluttered reading column, user bubbles, unboxed assistant turns, and a context toolbar in the composer. Errors and actual execution status remain visible.

This local Docker/SSH client does not prove AWS allocation, GPU execution, or public tenant isolation. Desktop has a self-contained development DMG build; it is not Developer ID signed or notarized.

## macOS website links in development

Run `npm run install:macos --prefix desktop` after installing dependencies. This
builds desktop and installs **alto Development.app** in `~/Applications`, with
the `agentcloud://` URL scheme declared in its bundle. Quit a running development
Electron instance before installing so the new bundle can register itself.
Website **Open in desktop** then launches alto even when it was closed.

Plain `electron .` cannot register macOS URL links with its project argument;
macOS otherwise launches Electron's welcome screen. Vite development launches
therefore leave the dedicated bundle's registration alone. The local bundle
links to this worktree's desktop directory: keep the worktree and rerun installation
when moving to another checkout. This is a local, ad-hoc-signed development
launcher, not a notarized distribution. It preserves the existing desktop
account/session storage. `desktop/.env` supplies settings for Finder launches.

Environment links preserve the exact project and environment on startup and when
switching an already-open app. Codex readiness does not determine selection: an
unavailable environment stays selected with its status and a link to manage it.
The startup handoff is retained across renderer effect initialization; newer live
links take precedence over an outstanding startup link.

Startup link acknowledgements are scoped to the destination a renderer received.
An older project-loading request cannot clear a newer environment link while
authentication and project data are loading concurrently.

## Bundled terminal CLI and macOS DMG

`npm run package:macos --prefix desktop` builds a self-contained `alto.app` and
writes `artifacts/desktop/alto-<version>-macos-<architecture>.dmg`. Run it on macOS
after `npm ci` at the repository root and in `desktop/`. It packages the local
machine architecture. Existing DMGs are preserved; move an older artifact before
rebuilding the same version. `npm run test:packaging --prefix desktop` checks
launcher symlinks, argument preservation, and the copied SSH runtime dependency.

The disk image contains the app, an Applications shortcut, and CLI installation
instructions. Drag the app into Applications, launch it, and sign in to the
same backend that owns your environments. Then install its bundled helper:

```sh
/Applications/alto.app/Contents/Resources/bin/alto install
```

This creates `~/.local/bin/alto`; it refuses to overwrite unrelated files. If that
directory is not already on your PATH, add `export PATH="$HOME/.local/bin:$PATH"`
to `~/.zshrc`, then open a new terminal. Run `alto --help` for available commands.
The helper can also be invoked at its full path without installation. Move the app
to its final location before installing the helper, and reinstall the link after
moving the app. No separate Node installation is required for end users.

The CLI uses the running desktop app's authenticated session and device SSH key.
Desktop must be open and signed in. Credentials remain in desktop's existing
storage; installing the CLI does not export a private key to the terminal.
`alto ssh <environment-id>` connects to the selected environment with its pinned
host key. This grants trusted shell access; it does not sandbox remote commands.
Device-key authorization can wait for the environment worker to reconcile keys.

The package contains built renderer/main/preload outputs, CLI files, Electron,
and ssh2's JavaScript runtime dependencies and licenses. Optional native SSH
acceleration is omitted to avoid Node/Electron ABI differences. The app contains
no symlink to a source checkout and copies no `.env`, account state, SSH keys, or
Doppler secrets. Backend settings use the existing desktop configuration and
sign-in flow. This is an ad-hoc-signed development DMG, **not Developer ID signed
or notarized**; macOS distribution trust and notarization remain release work.
The packaging command verifies the bundle signature, loads ssh2 using bundled
Electron, and runs the bundled CLI's help command before creating the image.

## Create projects in desktop

The project-selection screen includes an inline creation form matching the web's
name, HTTPS repository, template, and compute metadata fields. New project returns
to this screen from chat. Creation uses the existing authenticated `createProject`
action and server organization-admin authorization; errors keep entered values.
Success selects the returned project. Saving metadata does not clone a repository,
connect to SSH, provision compute, or start an agent.
