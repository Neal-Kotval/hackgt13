# Stage 2 contract: Codex in the environment (HAC-120)

Status: in progress. This is the shared interface for the parallel lanes HAC-121…HAC-126. It describes planned behavior until each lane lands and is verified. Design rationale: the Stage 2 design proposal (Obsidian `AgentCloud/Stage 2 - Codex in the Environment.md`).

Decisions:
- Codex CLI pinned at **0.157.1**.
- Sign-in is **per employee, ChatGPT device auth**, run inside the environment. There is no shared API key, and the desktop app never receives a token.
- One `codex exec --json` per prompt.
- Auto-approve inside the box, which is labelled **trusted shell access**.

## Environment (box) layout

| Item | Value |
| --- | --- |
| Account | `agentcloud` (non-root), as today |
| Codex binary | `codex` on `PATH` (`/usr/local/bin/codex` or the npm global bin), version `0.157.1` |
| Other tools | `git`, `tmux`, `bash`, Node 22 |
| Workspace (repo checkout) | Docker: `/home/agentcloud/workspace/repo` (or `/home/agentcloud/workspace` when no repo). Runpod: `/home/agentcloud/agentcloud/<jobId>`. AWS `aws-cpu`: `/home/agentcloud/agentcloud/<jobId>/repo`. Always read `workspacePath` from the API; never hardcode it. |
| Codex auth | `~/.codex/auth.json` (0600), created by `codex login --device-auth`; removed at teardown |
| Terminal session | tmux session named `agentcloud` |
| AgentCloud scratch | `/tmp/agentcloud-*` and `~/.cache/agentcloud` only |

## Listing additions (HAC-121): `GET /api/run-boxes?projectId=`

Each job gains:

```jsonc
{
  "workspacePath": "/home/agentcloud/workspace/repo" | null,   // null until ready
  "agent": {
    "codex": { "state": "pending" | "ready" | "failed", "version": "0.157.1" | null, "reason": string | null }
  }
}
```

`agent.codex.state` is `ready` only after the worker ran `codex --version` over SSH as `agentcloud` and saw the pinned version. That result is recorded as evidence in table `run_box_agent_check (job_id, agent, version, checked_at, ok, reason)`. The environment's own `state` (`ready`, etc.) is unchanged, so SSH readiness and agent readiness are separate facts.

**Teardown cleanup:** before removing a box on stop, expiry or reconciliation, the worker runs, best effort over SSH as `agentcloud`:

```
codex logout || true; rm -f ~/.codex/auth.json; rm -rf /tmp/agentcloud-* ~/.cache/agentcloud
```

It then records `run_box_cleanup_log (job_id, step, ok, at)`. A cleanup failure never blocks teardown.

## Agent run events (HAC-124)

SQLite tables in the auth DB (`lib/agent-runs.mjs`):
- `agent_run`: `id`, `run_box_id`, `project_id`, `employee_id`, `agent` (`codex`), `prompt` (≤ 4000 chars), `status` (`running`|`succeeded`|`failed`|`cancelled`), `started_at`, `finished_at`, `exit_code`.
- `agent_run_event`: `run_id`, `seq`, `kind`, `actor` (`codex`|`employee`), `text` (≤ 8192 chars, truncated with a marker), `command`, `exit_code`, `at`; primary key `(run_id, seq)`.

Event `kind`s: `message`, `reasoning`, `command.start`, `command.output`, `command.exit`, `file.change`, `error`, `terminal.command` (command-bar input), `status`.

All routes need an employee session and project membership. `POST` routes check same origin (the desktop main process passes; see HAC-87).

```
POST /api/agent-runs                    { runBoxId, agent: "codex", prompt }       -> 201 { run }   (409 unless the environment is ready)
POST /api/agent-runs/:id/events         { events: [{ seq, kind, actor, text?, command?, exitCode?, at }] }  -> { accepted, duplicates }   (idempotent by seq; ≤ 200 events per call; only the run's employee)
POST /api/agent-runs/:id/finish         { status, exitCode? }                      -> { run }
GET  /api/agent-runs?projectId=         -> { runs: [...] }          (newest first, no events)
GET  /api/agent-runs/:id                -> { run, events: [...] }
```

## Desktop IPC (HAC-122 Codex panel, HAC-123 terminal)

All SSH happens in the main process, over the existing pinned host key and device key (`/api/run-boxes/:id/connection`). Tokens and private keys never go over IPC.

Codex (HAC-122):

```
codex:status   (runBoxId)                 -> { signedIn: boolean, detail }      // `codex login status`
codex:login    (runBoxId)                 -> emits codex:event { type: "device-code", url, code } then { type: "signed-in" } | { type: "error" }
codex:run      (runBoxId, prompt)         -> { sessionId, runId }               // creates agent_run, streams events
codex:stop     (sessionId)                -> void                                // kills the remote process
codex:export   (runBoxId)                 -> { savedTo }                        // git diff in workspacePath → local .patch via save dialog
event channel  codex:event  { sessionId, runId, seq, kind, actor, text?, command?, exitCode?, at }
```

The remote command is run in `workspacePath`:

```
codex exec --json --ephemeral --skip-git-repo-check -s danger-full-access -C <workspacePath> -- <prompt>
```

The Codex sandbox is disabled because the box itself is the boundary. The UI must say **Trusted shell access**.

Terminal (HAC-123):

```
terminal:open (runBoxId) attaches to the tmux session: `tmux new-session -A -s agentcloud` (plain login shell if tmux is missing)
terminal:sendCommand (runBoxId, text)     -> runs `tmux send-keys -t agentcloud -l -- <text>` then Enter
```

Command-bar input is also posted as a `terminal.command` run event when a run is active.

## Deep links (HAC-123)

Web → desktop:

```
agentcloud://open?projectId=<id>&runBoxId=<id>[&panel=codex|terminal][&runId=<id>]
```

- The existing `environmentId` form stays supported. Host and port are never taken from the URL.
- Links are queued until sign-in and the project list are loaded, then routed to the Environments view with that environment selected and the panel open.

Desktop → web ("View on web" opens the system browser at `AGENTCLOUD_URL`):
- `/projects/<projectId>/environments#rb-<runBoxId>`
- `/projects/<projectId>/runs?run=<runId>`

The web Environments card uses `id="rb-<runBoxId>"`. The web Runs page reads `?run=` to open the run detail (HAC-124).

## Ownership (to avoid conflicts)

| Lane | Owns |
| --- | --- |
| HAC-121 | `infra/sandbox/**`, `lib/docker-sandbox-*.mjs`, `lib/runpod-worker.mjs` (start script only), new `lib/agent-check.mjs`, the `workspacePath`/`agent` fields in the GET of `app/api/run-boxes/route.ts` |
| HAC-122 | `desktop/electron/codex-*.ts`, `desktop/src/components/CodexPanel.tsx`, `desktop/src/lib/codex-*.ts`, and minimal registration lines in `desktop/electron/main.ts`/`preload.ts` |
| HAC-123 | `desktop/electron/ssh-terminal.ts`, `terminal-sessions.ts`, `desktop/src/lib/deep-link.ts`, `desktop/src/components/TerminalPanel.tsx`, `EnvironmentsPanel.tsx`, and the routing in `desktop/src/App.tsx` |
| HAC-124 | `lib/agent-runs.mjs`, `app/api/agent-runs/**`, `components/runs/**`, and the `id="rb-…"` anchor on web environment cards |
| HAC-125 | `infra/aws/**` (plan only), EC2 CPU provider and profile files |
| HAC-126 | `components/resources/**`, the Requests placement in `components/cloud-app.tsx`, `justfile` Runpod recipes |
