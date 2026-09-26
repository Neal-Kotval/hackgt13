# HAC-119 — Desktop project chat redesign

## Changes

- One shared sidebar for app navigation and chat history; history is reached through the existing focus-managed drawer on narrow windows.
- Centered empty greeting and composer, constrained conversation column, quiet user bubbles, and unboxed assistant replies using existing web tokens.
- Removed repeated setup/storage explanations, message counts, timestamps, and visible keyboard-help text. Actionable configuration errors and failed/stopped/responding states remain visible.
- Accessible icon controls for new chat, delete, send, and stop. IME composition does not trigger send. Keyboard focus recovers after a history row is deleted.

## Verification (2026-09-26)

- `npm run check --prefix desktop`: passed.
- `npm run build --prefix desktop` with Node 22.20.0: passed (existing large-bundle advisory).
- `npm test --prefix desktop` with Node 22.20.0: 56 passed, 0 failed, 0 skipped.
- `npm run tokens:check`: passed, 41 files checked.
- `git diff --check`: passed.
- Independent code review caught focus loss after drawer deletion; fixed and repeated the keyboard reproduction successfully.

Headless Playwright/Chrome exercised the actual Vite desktop renderer at **375, 768, and 1440px**, each 900px tall. Checks covered empty and long conversations, first send, multiline input, IME Enter, preserved per-chat drafts, streaming/stop/error rendering, drawer inert state, Tab/Shift+Tab wrapping, Escape and restored focus, keyboard deletion of remaining and final chats, and reduced-motion scrolling. The composer remained within the viewport; neither the document nor conversation overflowed horizontally. No page errors were recorded. Screenshots were visually inspected. Local evidence is in `artifacts/hac-119/` (ignored by Git).

The dedicated Playwright MCP was unavailable; checks used the installed Playwright library in headless Chrome, first through the Node MCP and then a repeatable local script. An isolated in-memory Electron bridge supplied test-only UI states; no test content was added to the application or real user storage. These checks verify renderer behavior, not real model execution, server connectivity, or Electron IPC. The first build attempt used npm's Node 18 and failed Vite's runtime requirement; rerunning under installed Node 22 passed.
