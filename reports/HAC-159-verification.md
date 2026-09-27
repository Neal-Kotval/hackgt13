# HAC-159: environment-based Codex chat

## Final integration

Preserves HAC-153's backend-owned SSH/app-server protocol, persistent session
history and ChatGPT device sign-in. Project chat only offers standard environments;
legacy local Docker sessions are filtered from selection and history. Settings no
longer renders the standalone local Codex creation panel. Website handoffs include
`runBoxId` and `panel=codex`; Docker remains labeled as a local test provider.

The first implementation used the older direct desktop SSH bridge, with a real
successful turn recorded as `c4bf1a88-43ff-456a-89d5-249d7186b354`. HAC-153 landed
while this work was in progress, so that bridge was replaced by the current main
architecture rather than reintroduced after its removal.

## UI verification

Headless website and desktop checks passed at 375, 768, and 1440 pixels. Website
Settings has no standalone panel, the real Docker job uses the standard environment
list, and the desktop link identifies the project, environment and server.

The reported composer regression was reproduced: grid-only centering no longer
worked inside a flex wrapper. The final shared composer has auto inline margins
and cross-axis centering, and retains the existing width token. Browser geometry
assertions compare composer center with the content pane and both edges with
conversation content at every viewport, for empty, active and streaming chats.
The final implementation uses main's original grid layout; the obsolete flex
wrapper and direct-SSH Codex panel are gone.

Browser regression checks cover persistent remote replies, ChatGPT device sign-in,
request-ID recovery, retry, drafts, attachment handling, search, and hiding legacy
local sessions. Remote session creation includes an actual selected runBoxId.
Type checking, token checks, and production builds passed. Current desktop unit
checks pass; the predecessor implementation also passed all 116 tests including
Docker SSH integration, but those removed tests do not verify the new transport.

## Local environment

A new standard environment was allocated through the authenticated owner API with
the current worker, installing its backend runner key and verifying pinned SSH,
repository clone, and Codex readiness:
`d0e41648-0251-45be-ad7b-282696fa065d` (docker-local, two-hour limit).
The obsolete direct-SSH test environment was stopped through its normal API.
The standalone legacy container is stopped and its persistent volume retained.
No AWS provisioning or deployment was performed.

Backend session `4af537a8-514c-4663-9547-358445cc88d6` initialized over SSH and reached
ChatGPT device sign-in. The copied old credentials had expired, so fresh sign-in
was requested rather than reporting a successful live turn on the new protocol.

## Sign-in and recovered connection history follow-up

The user completed ChatGPT sign-in. The backend session became ready and a real
`hi` turn received `Hi! What would you like to work on?`, followed by a completed
turn. The old pre-sign-in failures remained historical error events, not current
connection failures. The renderer now groups those errors under a collapsed
resolved-history disclosure only after a later explicit workspace-ready event.
Current connection failures and execution errors remain alerts. Browser tests
verify collapsed/expanded history and both unresolved error cases; responsive,
build, and token checks passed. Native verification confirms the successful reply
remains visible, history is collapsed, and no current alerts are present.
