# HAC-129 verification

Project chat is the desktop Codex conversation surface. Agent setup remains in website Settings. The separate Codex agents navigation item is removed; task and environment destinations remain. The newly merged HAC-102 server transport and legacy local history files are retained, but Project chat consumes authenticated Codex session snapshots.

## Checks

- Desktop TypeScript check: passed.
- Desktop tests: 55 passed, 0 failed (`AGENTCLOUD_SKIP_DOCKER_TESTS=1`, excludes unrelated SSH Docker integration).
- Token contract: 49 files, 169 centralized tokens, passed.
- Desktop production build: passed; existing large-bundle advisory remains.
- Headless Playwright against built renderer, forwarding through the real signed-in Electron bridge: 375, 768 and 1440px, no horizontal overflow; composer stays inside viewport. Project selector remains open across polling, Tasks navigation retains the unsent draft, and expandable command output renders real stored events.
- Real Codex turn read the existing verification file in the authenticated Docker box and returned its exact contents. No workspace files changed.
- Reproduced an early Stop click being ignored during message submission; disabled Stop while the request is pending. Repeated on the rebuilt renderer: message and interrupt both returned 200 and server history reported Turn interrupted.
- Browser-only injected ambiguous-send response retained the draft, disabled ordinary Send, and offered explicit Send as a new turn. No injected message was sent to the server.
- Reviewed routing, draft handling, retry selection and mobile focus. Corrected focus repair interfering with the select portal and kept the selected session on connection retry.

No AWS deployment. Existing Codex authentication, history and Docker workspace retained.

Integrated subsequent main changes without removing website-linked SSH terminals. Run-box links still open the terminal within Project chat; Back to chat or selecting an agent conversation returns to Codex.
