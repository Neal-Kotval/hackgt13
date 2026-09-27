# Environment model contract (names, visibility, delete, detail page)

Shared interface for the parallel slices that make environments first-class. Each slice owns the
files listed under it. Anything that changes this contract must be called out in the PR.

## Data (slice A owns)

New table `run_box_metadata` in the auth SQLite DB, created by `lib/run-box-metadata.mjs`
(migration in the same style as `lib/run-box-jobs.mjs`; do not alter `run_box_job` columns):

| column | type | notes |
|---|---|---|
| job_id | TEXT PK | references run_box_job.id |
| name | TEXT NULL | 1–60 chars after trim, no control characters; null = unnamed |
| visibility | TEXT NOT NULL | `private` or `public` |
| deleted_at | TEXT NULL | ISO time; set by delete |
| deleted_by | TEXT NULL | employee id |
| updated_at | TEXT NOT NULL | |

Defaults: a job with no metadata row (created before this change) is treated as `public`,
which preserves today's behavior (every project member can see it). New jobs default to `private`.

## Access policy (slice A enforces; UI slices only reflect `permissions`)

- **Private**: only the creator (the employee who requested the job) can see it in lists, open it,
  use chat or terminal, rename, change visibility, stop, or delete it.
- **Public**: every member of the project can see, open, chat, use the terminal, and stop it.
  Only the creator or a project owner can rename, change visibility, or delete it.
- Platform admin force close (`/admin/aws`) still works on everything.
- Deleted jobs are hidden from every list and detail view, but their audit rows stay.
- Unauthorized requests get a 404 for private jobs (don't reveal they exist) and a 403 for
  permission failures on visible jobs.
- The same checks apply everywhere a job is reachable:
  - `GET /api/run-boxes`;
  - the connection and ssh-access routes;
  - `/api/codex-sessions` (listing, creating and sending on a private environment's sessions);
  - chat-runs;
  - the new terminal route.

## API (slice A owns routes; others consume)

Job JSON (in `GET/POST /api/run-boxes` and the new single-job GET) gains:

```ts
name: string | null;
visibility: "private" | "public";
createdBy: { id: string; name: string; email: string } | null;
permissions: { open: boolean; stop: boolean; manage: boolean }; // manage = rename/visibility/delete
```

- `POST /api/run-boxes` also accepts optional `name` and `visibility` (default `private`).
- `GET /api/run-boxes/:id?projectId=` returns `{ job }` for one job.
- `PATCH /api/run-boxes/:id` takes `{ projectId, name?: string | null, visibility?: "private" | "public" }` and returns `{ job }`.
- `DELETE /api/run-boxes/:id?projectId=` requests a stop (a force stop if the job is already
  `stopping`), then marks the job deleted. It returns `{ ok: true }` and is idempotent. It never
  skips the cleanup and termination path: the worker still terminates and proves release.
- All mutating routes require the same Origin and session checks as the existing stop route.
  Record the actor in `run_box_transition` or an audit row, as the stop route does.

## Web routes and UI (slices B, C, D, E)

- Environment detail page: `/projects/:projectId/environments/:jobId`, rendered by
  `components/cloud-app.tsx`, which already maps paths to pages. Slice B owns
  `components/environment-detail/index.tsx` and `environment-detail.css`, and the page's
  Overview and Settings tabs.
- Tabs: **Overview** (machine, state, time left, repo, creator, visibility), **Chat**,
  **Terminal**, **Settings** (name, visibility, and delete with a confirmation dialog).
  Tab state lives in `?tab=overview|chat|terminal|settings`.
- Slice D owns `components/environment-detail/chat.tsx`, exporting
  `export function EnvironmentChat(props: { projectId: string; job: RunBoxJob }): JSX.Element`.
- Slice C owns `components/environment-detail/terminal.tsx`, exporting
  `export function EnvironmentTerminal(props: { projectId: string; job: RunBoxJob }): JSX.Element`,
  plus the terminal API and server bridge.
- Slice B commits placeholder versions of `chat.tsx` and `terminal.tsx` with exactly these
  signatures, so its page builds on its own. Slices C and D replace them; at merge time, their
  versions win.
- Slice E owns project Settings: `components/project-settings/**`, and wiring page `settings` in
  cloud-app to it.

## Out of scope for this round

- Restarting a stopped environment (EC2 stop/start or saving work on Stop, HAC-127).
- Public access outside the project.
- Per-environment Codex model settings.
