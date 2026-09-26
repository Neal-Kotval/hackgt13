# HAC-60 — Compact menus and navigation

Implemented in a new worktree from `origin/main` (`fb06cf0`). Dropdown triggers now use the 32px control token and 4px/12px padding with an 8px label gap. The opened menu uses the shared square panel, divider, typography, cyan selection, and muted highlight styles. Radix Select supplies keyboard/focus behavior; its runtime positioning measurements are documented separately from authored visual tokens. Existing optional empty values and required form validation are preserved. Page links have borders, surface backgrounds, hover feedback and cyan current states.

## Verification

- Token enforcement: 21 files, 138 centralized tokens; passed.
- TypeScript and production build: passed.
- Backend tests: 29 passed.
- Existing auth browser suite: both employees at 375/768/1440px, including session persistence across restart; passed.
- New `npm run test:select:browser`: passed at 375/768/1440px. Covers keyboard arrows, typeahead, Escape/focus return, selected template persistence, empty dependency submission and clearing, required validation, menu portals inside native dialogs, navigation state and viewport bounds.
- Headless Playwright exploration through Node MCP: 21 open-menu route/viewport combinations (organizations, project setup, resources, requests, runs, inference and design-system) fit the viewport, with no body overflow or page errors. Measured triggers were 32px. Found and fixed a mobile selector that hid the new wrapper along with the old label text.
- Independent implementation review: no remaining actionable findings.

Checks used isolated test accounts/data, not the user's preview records. Local screenshots are in ignored `artifacts/compact-menu-{375,768,1440}.png`. Remote execution, provisioning, and production tenant isolation remain outside this change. Headless Chrome was verified; other browser engines were not independently exercised.
