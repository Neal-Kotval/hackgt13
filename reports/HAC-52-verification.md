# HAC-52 — AgentCloud v4 redesign verification

The web app now follows the supplied AgentCloud Mockup v4 visual language: a dark canvas, flat square panels, hairline dividers, left navigation, square status marks, outlined status labels, and locally bundled Hanken Grotesk headings with JetBrains Mono details. All visual values remain centralized in `app/tokens.css`; component styles consume semantic tokens. The existing application routes and backend contracts are preserved. Reference-only GPU jobs, safety checks, and access decisions are not implemented or simulated.

Work started from `origin/main` at `c6d35c8` in the dedicated `hackgt13-hac-52` worktree on `codex/hac-52-v4-redesign`. The original checkout was not edited.

## Validation

Validated application code through `43b05bf` with Node 22.20.0:

- `npm run tokens:check`: passed, 19 files and 129 centralized tokens.
- `npm run check`: passed.
- `npm test`: all 29 backend tests passed.
- `npm run build`: production Turbopack build passed.
- `npm run test:auth:browser`: both test employees passed login, organization selection, refresh, logout, and overflow checks at 375px, 768px, and 1440px; session survived server restart. This ran before the final dialog-only focus fix.
- Headless Playwright through the Node MCP tool: project list, setup, dashboard, resources, requests, runs, graph, inference, agent connection, review, organizations, and design-system pages had no body overflow at 375px, 768px, 900px, and 1440px. No page errors were reported.
- Created projects through the real form in a temporary test data directory; checked hosted metadata and SSH setup inputs. No product fixtures or sample activity were added to the running application.
- Keyboard: skip link reached the main landmark. Opening a task dialog with Enter and dismissing with Escape returned focus to New task. The dialog had no internal horizontal overflow at 375px, 768px, and 1440px; focused controls showed a solid outline. Reduced-motion mode resolved the fast duration to zero.
- Independent diff review caught and resolved inherited filled status tags and intermediate-width review layout. A dialog focus-return defect found during browser exploration was reproduced and fixed.

Local screenshots are in the ignored `artifacts/` directory: `v4-projects-desktop.png` and `v4-dashboard-{375,768,1440}.png`. They are verification artifacts, not seeded application data.

## Limits

The redesign preserves the local coordination boundary. It does not provision remote compute, verify SSH/GPU access, execute agents, or add real run telemetry. Browser checks used isolated local test accounts and empty initial project state; they do not certify production tenant isolation or remote execution. No dedicated Playwright MCP server was exposed, so the checks used headless Playwright through the available Node MCP tool. The initial default Node 18 build and an external dependency symlink failed; the successful build used Node 22 with dependencies copied into the new worktree.
