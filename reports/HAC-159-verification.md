# HAC-159: environment-based Codex chat

## Website

Removed the standalone local Codex creation/sign-in panel from Settings. Website
Environments is the setup/lifecycle surface; Continue in desktop points to the
project/run-box chat. Removed the duplicate terminal deep-link action; a terminal
remains available explicitly on the selected environment in desktop.

Live headless Playwright checks against port3001 with the existing account passed
at375/768/1440: Settings has no standalone panel, the real Docker job appears in
the standard environment list, and the handoff identifies the correct project,
run-box and server. No horizontal overflow at those sizes.

## Standard Docker test environment

Created through authenticated POST /api/run-boxes, not direct database insertion:
`ddb19d94-b78e-458b-bc22-40780487fe33` (docker-local, two-hour limit).
The normal worker built the sandbox image, cloned the configured repository,
verified pinned SSH access as the non-root environment user, and recorded
Codex0.157.1 readiness. The existing ChatGPT test sign-in was streamed privately
between container credential files and verified without exposing its contents.
The old persistent volume/history is retained; it is not silently imported into
the SSH conversation path. No AWS provision/deploy action was performed.

## Desktop

The updated native app selected that standard environment and completed a real
ChatGPT-authenticated Codex turn through SSH. The server recorded run
`c4bf1a88-43ff-456a-89d5-249d7186b354` as succeeded for the run-box above.
The old standalone app-server container was then stopped, preserving its volume.

Headless browser checks passed at 375, 768, and 1440 pixels: environment selection,
sign-in/cancel/re-sign-in, streamed replies, early IPC events, attachments, drafts,
failed sends, Stop, legacy links, server-origin guards, Environments-to-chat
navigation, and stale readiness. A user-reported composer alignment regression
was reproduced: grid-only centering stopped working inside the new flex wrapper.
Auto inline margins now center the composer; the transcript fills remaining height.
Geometry assertions verify that composer and assistant message edges and widths
match at each viewport. Native measurement also confirms identical 736px widths
and left edges, without reloading the user's conversation.

Existing transport limitation: each prompt uses `codex exec` with bounded prior
context. Chats and drafts survive navigation within the app, not app relaunch;
recorded execution runs remain on the server.
