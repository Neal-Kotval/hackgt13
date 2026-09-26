# Verification record

Recorded during implementation on 2026-09-26. The latest `just verify` passed TypeScript, all 15 backend/workspace tests, token enforcement, and the production build. A second production build passed after the final responsive CSS adjustment. Historical CLI evidence is identified separately below. There is no release commit identifier yet.

| Check | Evidence |
| --- | --- |
| Dependency installation | `npm install` completed and reported 0 vulnerabilities at installation time |
| Type checking | Current `just verify`: TypeScript passed |
| Token enforcement | Current `just verify`: passed with 122 tokens |
| Production build | Current `just verify`: optimized Next.js 16.3.6 production build passed |
| Backend behavior / authorization | Current revision: all 15 tests passed, including resource validation, legacy state compatibility, and browser-origin handling |
| API coordination | Current authenticated service registration and handoff creation verified with browser-visible results |
| CLI transport | Historical smoke pass for connect, service, handoff, and context; current revision re-run pending |
| Playwright browser QA | Passed the earlier coordination flows and the new control-plane flows below through headless Playwright MCP |
| Real remote two-agent workflow | Not implemented and not verified |

## Browser verification

Headless Playwright MCP exercised the application at explicit widths of **375px, 768px, and 1440px**. The Projects empty state and populated dashboard, board, services, and review views showed no horizontal overflow or browser errors in the reported checks. Setup's SSH toggle was inspected at these widths. Design-system, agent, and CLI instruction pages also showed no overflow or browser errors. Keyboard focus had a visible 2px outline.

Verified interactions:

- Fresh storage showed an empty Projects view, with no seeded project cards.
- Project creation completed through a real browser request and navigated to the saved project.
- Agent registration displayed the one-time credential; public `GET /api/state` did not expose that token.
- Task creation saved a real task. Attempting to advance a task with an incomplete dependency returned HTTP 409; both UI and backend retained its queued state.
- Authenticated API operations registered a service and created a handoff. The UI displayed these records, and accepting the handoff created a follow-up task.
- Review displayed handoff records and the intentional future-state Changes and Checks panels.

These checks cover the observed local workflows, not remote agent execution or all possible input combinations.

## Control-plane browser verification

The new UI was checked against a production server on loopback port 3100 with an isolated temporary data directory. Headless Playwright MCP created a project through the UI, registered a GPU **catalog record** (unverified), saved a request with a `not_evaluated` policy decision, saved an inference API configuration draft, and confirmed the graph projected the persisted request relationship and unlinked draft node. Runs showed stored activity, transport status, and an explicit empty state for command results. A simulated HTTP 409 response in the browser displayed its server error and did not add a request.

At explicit **375px, 768px, and 1440px** widths, Playwright navigated Resources, Requests, Runs, Graph, and Inference. Each had no body-level overflow, clipped control-plane links, page errors, or console errors. The resource form was opened, the Runs identity filter was exercised, and keyboard traversal produced a visible 2px focus outline at each width. A first visual pass found the mobile subnavigation clipped Graph; after changing it to wrap, the same responsive checks passed. Screenshots were inspected for the 375px graph and 375px/1440px resource views.

This evidence proves local record creation and presentation only. It does not prove an employee policy decision, remote resource availability, model execution, GPU access, or an inference service.

## Reproduced and verified fix

The first browser project-creation attempt failed with HTTP 403 because the Next.js request URL and the request Host differed during origin validation. The parent agent corrected `lib/http.ts`, repeated the browser action, and observed HTTP 200 followed by successful project navigation. Backend regression coverage was added; the eight-test suite passed afterward.

Earlier browser QA was blocked by an automatic approval policy reporting `approval policy never`. That historical block no longer describes the current result: the headless Playwright MCP checks above completed successfully.

## Capability boundary

The application implements local coordination and resource/request/draft records, credential-scoped agent API operations, a CLI transport, and a persisted-record graph projection. It starts empty and has no seeded project or replay workflow. The local Git provider has isolated clone/worktree tests but is not integrated into the product flow. No recorded check proves remote provisioning, actual Codex or Claude execution, real service health, Git diff retrieval, command execution, GPU use, policy enforcement, or merging. Review's Changes and Checks panels intentionally describe future capabilities; handoffs are functional records.

## Data transition and cleanup

The runtime starts with `{projects: [], revision: 0}` when no state file exists. Seed loading and replay/advance actions have been removed. A one-time local cleanup removed the previously known generated demonstration and QA projects and their credentials; the server does not automatically delete arbitrary saved projects on startup.

Browser verification created temporary project `6c6237f6-6acd-47f6-a540-057c929be940` through the real application. After stopping the development server, its records and credentials were removed atomically. Final local state contains **0 projects and 0 credentials**. No source fixture or startup seed remains.

The new control-plane browser pass used a separate temporary data directory under `/tmp`; it did not change the main application state or add startup fixtures.
