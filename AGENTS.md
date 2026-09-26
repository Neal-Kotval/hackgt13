# AgentCloud repository instructions

Read PRODUCT.md, DESIGN.md, ARCHITECTURE.md, and ROADMAP.md before making material changes. Preserve the distinction between the functioning local coordination layer and planned remote infrastructure.

## Collaboration

Other agents may be editing this repository. Own explicit files or modules, coordinate shared interfaces, and never revert another agent's unrelated work. Keep changes scoped to the user's request.

### Feature delivery workflow

For every new feature, start from the latest `origin/main` in a dedicated Git worktree with its own branch. Keep `main` for integration and releases; do not develop features in the main worktree. Use the relevant `HAC` issue identifier in the branch name.

Move quickly by assigning independent, well-scoped slices to agents in parallel. Give each agent its own worktree, explicit file or module ownership, and a shared interface before work begins. Integrate through commits and pull requests, not by editing another agent's worktree or bundling unfinished changes. Keep handoffs short and include changed files, verification results, and any dependency for the next agent.

Push each completed feature branch, open a pull request targeting `main`, run the relevant checks, and review the diff. Resolve feedback and conflicts on the feature branch, then merge the pull request after its checks and review pass. Update the worktree from the resulting `main` before starting dependent work. Do not force-push or bypass a failing check to save time.

Before substantial code changes, run `git status --short` and `git fetch origin`, then compare the current branch with its upstream branch (or `origin/main` if it has no upstream). Review any new commits and changed files that overlap your work, and adjust your plan before editing. If the fetch fails, say that the remote check could not be completed. Do not automatically merge, rebase, reset, or overwrite local work.

Commit and push completed work in small, coherent batches, especially before switching tasks or handing work to another agent. Check the remote branch again before pushing, resolve any divergence without force pushing, and do not include another agent's unfinished changes unless the user asks to push everything.

## Linear tickets

Use the [hackgt13 team in Linear](https://linear.app/startup-yc/team/HAC) for work on this repository. Keep each ticket in the project that owns the work: [backend](https://linear.app/startup-yc/project/backend-711b9afb252a) for server, API, infrastructure, and agent execution; [website](https://linear.app/startup-yc/project/website-e419f107b22a) for the web application; and [desktop](https://linear.app/startup-yc/project/desktop-66676b50dadd) for the native desktop shell. For work spanning projects, file the main ticket in the project with primary implementation ownership and link related tickets in the other projects when they have separate deliverables. Use the existing `HAC` team issue identifiers in branches and references.

## Local commands

Use the root `justfile` for common tasks: `just setup` installs dependencies and creates `.env.local` only when it is absent; `just` or `just dev` starts the loopback development server; `just build` and `just start` handle a local production build; `just verify` runs type checking, backend tests, the token check, and a production build. Run `just --list` to see individual recipes. The underlying npm scripts remain available. These commands start the local application only; they do not provision remote compute or execute agents.

## Design system

- Use only the tokens and semantic roles defined in DESIGN.md for visual styling.
- No raw component colors, arbitrary spacing, typography, radii, shadows, or ad hoc inline style values. Add a documented reusable token when the system truly needs one.
- Keep primitive values in the token source. Component styles consume semantic tokens.
- Do not copy raw inline styles from reference exports into production components.
- Run `npm run tokens:check` after visual changes and resolve violations.
- Preserve keyboard access, visible focus, reduced motion behavior, and readable status labels.

## Verification

For a bug: reproduce first, form a hypothesis, fix, then repeat the reproduction and report the evidence. Prefer a failing test where it captures real behavior.

After any UI change, use Playwright MCP in headless mode to open the running app and exercise the changed flow without focusing or recentering the user's browser tab. Specify 375px, 768px, and 1440px viewports for responsive checks. Never claim a UI works without that browser verification. For generated E2E tests, explore the flow through Playwright before writing the test.

Run the checks appropriate to the change. The repository exposes `npm run check`, `npm test`, `npm run tokens:check`, and `npm run build`. Report actual results and any unverified behavior; do not treat unavailable tooling as a passing check.

## Product truth and security

- Manage AgentCloud AWS resources through `infra/aws/` Terraform. Import preexisting account resources before modifying them, review the plan before apply, and never commit Terraform state or AWS credentials.

- Start with empty real project state. Do not add seeded projects, fake agent activity, sample diffs, or sample test results to the running product.
- A saved repository URL is not a completed clone; a branch name is not a created worktree; a registered endpoint is not a verified running service.
- A transport heartbeat is not evidence that Codex or Claude executed a task.
- Never expose or log plaintext agent tokens, SSH keys, model credentials, or connection secrets. Preserve credential scope checks and action attribution.
- Doppler CLI supplies local app secrets through `doppler run`; its experimental MCP server is for assistant-side Doppler management only. Use a config-scoped token, prefer read-only access, and never write a token or secret value to tracked files or tool output. See README.md.
- Unrestricted SSH is trusted access. Do not claim filesystem restrictions unless enforced at the execution boundary and verified with a denied action.
- Do not implement destructive merge/reset/provision actions behind controls presented as a preview.
- Keep the local single-user security boundary explicit. Production authentication and tenant isolation must precede public multi-user deployment.

Update relevant documentation when an implemented capability, setup command, API contract, or limitation changes. Keep reference/ as source material, not application runtime code.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
