# AgentCloud desktop

Desktop shell for HackGT ([HAC-16](https://linear.app/startup-yc/issue/HAC-16/d1-desktop-ship-codex-like-core-chat) chat scaffold + [HAC-29](https://linear.app/startup-yc/issue/HAC-29/d2-desktop-task-authoring-against-shared-backend-machine-first) task authoring). Separate from the Next.js coordination app. It does **not** provision run boxes or claim remote GPU execution.

## Information architecture (HAC-41)

One window, two primary sections:

| Section | Role |
| --- | --- |
| **Tasks** | Project/environment picker + task composer against the shared backend (`addTask`). Project chat is separate. |
| **Project chat** | Codex-like on-device threads (`threads.json`). Does **not** create AgentCloud tasks and does **not** sync to the web dashboard. |

Machine-first journey: connect/verify a machine in the **web** app → return to desktop **Tasks** to author work against a ready environment → monitor on the web. Project chat remains an optional scratchpad beside that flow.

Switching Tasks ↔ Project chat keeps in-memory chat drafts for the session.

## Prerequisites

- Node.js 22 LTS
- macOS (primary hackathon target)
- Reachable AgentCloud web app for employee sign-in (local `just dev` or the shared AWS URL)
- Optional: `OPENAI_API_KEY` for real assistant replies in Project chat

## Install and launch

From the repository root (preferred):

```sh
just desktop-setup   # once
just desktop         # launches Electron with Vite hot reload
just desktop-verify  # check + test + build
```

Other desktop recipes: `just desktop-check`, `just desktop-test`, `just desktop-build`, `just desktop-devtools`.

`just desktop` opens **one** desktop window. After sign-in you land on **Project chat**. **Tasks** is the shared-backend project panel. UI (renderer) edits hot-reload through Vite.

### Main-process HMR policy

Editing `electron/main.ts` (or other main-process code) rebuilds `dist-electron/main.js` but **does not** restart Electron automatically. That avoids killing a healthy chat window mid-session. Restart with `just desktop` after main-process changes.

If the renderer process still dies for another reason, the main process reloads the window (or shows an in-window error) instead of leaving a blank `#0f1112` shell.

### DevTools

DevTools stay **closed** by default so demos are a single chat window. To open docked DevTools:

```sh
just desktop-devtools
```

Or set `AGENTCLOUD_DESKTOP_DEVTOOLS=1` in `desktop/.env`. DevTools are attached to the chat window (not a detached orphan).

## Project chat loop

1. Sign in with the same Better Auth employee email/password as the web app (web must be running at `AGENTCLOUD_URL`, default `http://127.0.0.1:3000`).
2. Open **Project chat**. Type and **Enter** to send — the first send auto-creates a thread (no mandatory **New chat** click).
3. **Shift+Enter** inserts a newline. **New chat** still starts another empty thread while one is open.
4. With `OPENAI_API_KEY` set, the assistant streams a real reply into the thread.
5. Without credentials, the failed assistant turn explains how to configure `.env` — it does not invent a successful reply.
6. Create a second chat, switch between them or to **Tasks** and back — titles/messages reload from disk; drafts stay in memory for the session.
7. **Sign out** clears the employee session; relaunch shows the sign-in screen again (revoked sessions are not silently restored).

Unsent composer drafts are kept **per thread in memory** while the app runs (plus a landing draft when no thread is selected). They are cleared on send and are **not** restored after relaunch.

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

## Shared backend client (HAC-42)

Desktop calls the Next loopback API from the **main process** (Node `fetch`), not the renderer, so browser Origin/CORS does not block mutations. Session cookies come from the HAC-24 auth jar.

Renderer helpers: `desktop/src/lib/server-api.ts` → `getState()` / `postAction(body)`.

- `GET /api/state` — returns revision + project list (membership-scoped).
- `POST /api/state` — shared action envelope (e.g. future `addTask`); Origin set to `AGENTCLOUD_URL`.
- Server down → actionable error (“Start the web app with just…”). Cookies/tokens are never logged.

The **Tasks** panel loads live projects via `getState` (project picker). Empty servers show a connect-on-web CTA; resource statuses are shown as returned (`registered`, `verified`, `not_evaluated`, …) without inventing `ready`.

## Task authoring (HAC-33 / HAC-34 / HAC-64)

On **Tasks**, pick a project, then use **Create task** (title, instructions, agent, optional environment). Submit calls main-process `postAction` → `POST /api/state`:

```json
{
  "type": "addTask",
  "projectId": "…",
  "title": "…",
  "owner": "<agentId>",
  "instructions": "…",
  "environmentId": "<verified resource id, optional>"
}
```

`instructions` and `environmentId` round-trip in `GET /api/state`. Binding `environmentId` requires a project resource with status `verified`; unknown or unverified ids are rejected.

### Start agent (HAC-35)

The Tasks panel includes a **Start agent** control that selects a created task + verified environment. It stays **disabled** with an explicit reason: “Agent start requires remote runner — not implemented.” Desktop does not call Project chat / OpenAI as a substitute, and it never marks a task running without server evidence. When a start endpoint lands, wire it here with `taskId` + `environmentId` + agent owner and surface the server decision only.

## Deep links (HAC-54)

Desktop registers the `agentcloud://` URL scheme (dev + packaged). Open Tasks with:

```text
agentcloud://open?projectId=<id>&environmentId=<verified-resource-id>
```

`environmentId` is optional. On cold start or a second-instance handoff, the existing window is focused (no duplicate shell). Valid IDs switch to **Tasks** and preselect the project/environment. Missing projects, unknown resources, or unverified environments show an honest error — desktop never invents a ready box. Website “Open in desktop” UI is a separate ticket.

## Persistence

Threads live under the Electron `userData` chat directory (shown indirectly via the main process; path is available through the desktop bridge `dataDir`). Storage is a single `threads.json` file. Corrupt or missing storage surfaces an error screen instead of crashing in a loop.

Chat JSON never stores API keys or AgentCloud agent tokens. Credentials are read from `desktop/.env` / process env only.

## Checks

From the repository root:

```sh
just desktop-check   # TypeScript
just desktop-tokens  # design token contract (desktop + web)
just desktop-test    # local chat store tests
just desktop-build   # production renderer + electron bundles
just desktop-verify  # check + tokens + test + build
```

## Limitations (intentional for D1 + D2.0)

- **Tasks** is a labeled empty state until the composer ([HAC-33](https://linear.app/startup-yc/issue/HAC-33/d23-desktop-task-composer-ui-instructions-agent-environment)) and shared API create path ([HAC-34](https://linear.app/startup-yc/issue/HAC-34/d24-desktop-create-task-via-shared-backend-api)) land.
- Employee sign-in reuses Better Auth from the running web app ([HAC-24](https://linear.app/startup-yc/issue/HAC-24/d2-desktop-reuse-better-auth-employee-sessions-from-the-web-app)); SSO beyond HAC-1 is out of scope.
- No AgentCloud project sync, multi-agent handoffs, worktrees, or remote run-box control yet.
- Assistant path is an isolated OpenAI Chat Completions adapter; it can be replaced later without rewriting the chat UI.
- Plain-text message rendering only (markdown deferred).
- Not notarized / packaged for distribution.

## Design tokens

Renderer CSS imports the shared AgentCloud token file from `app/tokens.css`
(Hanken Grotesk / JetBrains Mono via `/fonts/*`). Vite serves the repo
`public/` directory as the desktop `publicDir`, so Electron resolves the same
font URLs as the Next app.

Do not invent a parallel palette in this package. Use semantic tokens only
(`.button`, `.eyebrow`, `.tag`, compact selects). `just desktop-verify` runs
`npm run tokens:check`, which scans `desktop/src/**/*.{css,tsx}` alongside web
surfaces and fails on raw colors, inline styles, or undefined tokens.

