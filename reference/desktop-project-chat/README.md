# Handoff: Desktop Project chat + history sidebar redesign

## Overview
This redesigns the **Project chat** section of the Electron desktop app (`desktop/`). The goals:
- Make it clear which project, agent and environment is replying.
- Give messages more structure (code, command steps, changed files, handoffs).
- Add context controls to the composer.
- Replace the generic empty state.
- Keep the existing single column for nav and chat history, and add search and date grouping to the history.

## About the design files
`Project Chat.dc.html` is a **design reference built in HTML**. It is not production code. Rebuild it in the existing desktop renderer (React 19 + Vite, `desktop/src`) using its current patterns:
- `desktop/src/styles.css` with classes that reference `app/tokens.css`
- Phosphor icons from `@phosphor-icons/react`
- the shared `Select` component

The HTML uses inline literal values only for prototyping. **Every value below maps to an existing token.** Follow `DESIGN.md`: no raw values or inline styles in app code, and `npm run tokens:check` must pass. Frame 2a is the redesign; frame 1a recreates the current app for comparison.

## Fidelity
**High fidelity.** Colors, type, spacing, radii and copy are final. Apply them through the token names listed here.

## Files to touch
- `desktop/src/App.tsx`: header context strip, empty-state layout, passing context to the composer
- `desktop/src/components/ThreadList.tsx`: search, date groups, streaming dot
- `desktop/src/components/Conversation.tsx`: agent header, rich message parts, status line, actions
- `desktop/src/components/Composer.tsx`: attachments, toolbar pickers, Stop state
- `desktop/src/components/ChatProjectPicker.tsx`: becomes compact picker chips (header strip + composer toolbar + empty state)
- `desktop/src/components/ShellNav.tsx`: sections are **Tasks, Environments, Project chat** (no Codex agents)
- `desktop/src/styles.css`: new classes
- `desktop/src/lib/types.ts`: message part types (see State)

## Screen: Project chat (1440×900 reference window)

### Shell (unchanged)
- Grid `var(--navigation-width)` (240px) | `minmax(0,1fr)`
- Glass nav: `--color-glass`, right border `--color-glass-edge`, `--shadow-glass`, padding `--space-5 --space-3`, gap `--space-8`
- Brand, nav tabs and account card stay exactly as they are today.

### Sidebar history (`ThreadList`)
Order: header → search → grouped list.
- **Header:** unchanged "Chats" label (body font, `--text-xs`, medium, `--color-muted`). The new-chat icon button shrinks to `--control-height-small` (32px) square, `--radius-sm`, `--color-surface` fill, `--color-border`. Icon `ph-note-pencil` at 18px.
- **Search field:**
  - 32px tall, `margin: 0 --space-1`, padding `0 --space-2 0 --space-3`, gap `--space-2`
  - Background `--color-bg`, border `--color-border-subtle`, `--radius-sm`
  - Leading `MagnifyingGlass` icon (`--icon-sm`, `--color-subtle`)
  - Input `--text-sm`, placeholder "Search chats" in `--color-muted`
  - Trailing `⌘K` hint: `--text-xs`, `--color-subtle`, 1px `--color-border-subtle` border, `--radius-xs`, padding `0 --space-1`
  - Filters threads by title as you type (case-insensitive substring match).
  - No matches: show `No chats match "<query>"` in the `.sidebar-empty` style.
  - ⌘K focuses the field.
- **Groups:** Today / Yesterday / Previous 7 days / Older, computed from `updatedAt`. Hide empty groups. Gap between groups `--space-4`.
  - Group label: `--text-xs`, uppercase, `--tracking-wide`, `--color-subtle`, padding `0 --space-3 --space-1` (same as the `.field-label` pattern).
- **Thread row:**
  - Min-height 36px (current rows are 40px; tighter so more fit), padding `--space-2 --space-3`, `--radius-navigation`
  - Title `--text-sm`, medium weight, ellipsis
  - Selected: `--color-glass-selected` fill, `--color-accent-hover` text. Hover: `--color-glass-hover` fill, `--color-text` text.
  - A thread whose last message is `streaming` shows a trailing `--dot-size` (6px) dot in `--color-warning`, with `title="Responding"`.
  - Keep the existing hover-revealed delete button and its confirmation.

### Main header
- Min-height `--header-height`, padding `--space-3 --page-gutter`, new bottom border `--color-border-subtle`.
- Left: thread title (h1, Hanken, `--text-lg`, semibold, `--tracking-tight`, ellipsis).
- Right, gap `--space-4`:
  - **Context strip:** hidden in the empty state.
    - One 32px bordered group: `--color-border`, `--radius-sm`, `--color-surface`, `--text-sm`
    - Three segments with padding `0 --space-3`, separated by 1px `--color-border-subtle` dividers:
      1. `FolderSimple` icon (`--color-muted`) + project name
      2. `Robot` icon + agent name, whole segment in `--color-agent-secondary`
      3. `HardDrives` icon (`--color-muted`) + environment name + status (6px dot + word). Ready = `--color-success`; provisioning = `--color-warning`; failed = `--color-danger`. Always show the status word, never just the color.
    - Each segment is a button that opens the matching picker. Hover: `--color-glass-hover`.
  - "Saved on this device" note: unchanged `.chat-storage-note`.
- If a run-box terminal is open (`chatRunBox`), keep today's behavior.

### Conversation column
Same scroller as today: padding `--space-8 max(--page-gutter, (100% - --content-narrow)/2)`, gap `--space-8`, stick-to-bottom.

1. **Environment status line** (first item when the thread has messages; also insert it when the connection state changes):
   - Row, gap `--space-2`, `--text-xs`, `--color-subtle`
   - 6px `--color-success` dot, then "Connected to **rtx-4090** over SSH · trusted shell access" (environment name in `--color-text`)
   - Followed by a `flex:1` 1px `--color-border-subtle` rule
   - Honesty rule: keep the "trusted shell access" wording.
2. **User turn:** unchanged (`--color-selected`, `--radius-lg`, padding `--space-3 --space-5`, max-width 85%, right aligned).
3. **Assistant turn:** column, gap `--space-3`.
   - **Agent header:**
     - 24px (`--icon-lg`) circle, `--color-agent-secondary-soft` fill, `Robot` icon at `--icon-sm` in `--color-agent-secondary`
     - Agent name: Hanken, `--text-sm`, semibold, `--color-text`
     - "on <environment>" in `--text-xs`, `--color-subtle`
     - This replaces the generic "Assistant" label.
   - **Tool steps, completed (collapsed by default):**
     - Left-aligned box, min-width 360px: `--color-border-subtle` border, `--radius-md`, `--color-surface`
     - Header button: padding `--space-2 --space-3`, gap `--space-2`, `--text-sm`, `--color-muted`
     - Header content: `TerminalWindow` icon, "Ran 4 commands" in `--color-text`, "· 38s" in `--color-subtle`, a result tag (`.tag.green` with a `Check` icon, e.g. "12 passed"), a spacer, then a `CaretDown`/`CaretUp` icon.
     - Expanded: rows separated by top borders in `--color-border-subtle`. Each row is padding `--space-2 --space-3`, gap `--space-3`: `$` in `--color-subtle`, the command in mono `--color-text` with ellipsis, and the result on the right (`--text-xs`, `--color-subtle`; a passing test count uses `--color-success`).
     - `aria-expanded` on the toggle.
   - **Tool step, running (streaming):**
     - Same box, but the border is `--color-warning` at roughly 35% mix, and min-width is 420px.
     - Header: "Running" + the command, with "step 2 of 3" on the right in `--color-warning` `--text-xs`.
     - Below it, a live output tail in a `<pre>`: `--color-bg`, `--text-xs`, `--color-muted`, last 3–5 lines.
   - **Markdown body:** `--text-base`, `--leading-relaxed`, `text-wrap: pretty`.
     - Inline code: `--color-selected` fill, `--radius-xs`, padding `1px 6px` (add a token if needed), `--text-sm`.
     - **Code block:**
       - Container: `--color-border`, `--radius-md`, `--color-surface`
       - Header bar: padding `--space-1 --space-1 --space-1 --space-3`, bottom border `--color-border-subtle`. Filename or language in `--text-xs` `--color-subtle`, plus a ghost "Copy" button (28px, `Copy` icon, `--text-xs`).
       - Body: `<pre>` with padding `--space-3 --space-4`, `--text-sm`, `--leading-normal`, horizontal scroll
       - Syntax colors: comments `--color-subtle`, keywords `--color-accent`, strings `--color-success`.
   - **Changed files card:**
     - `--color-border`, `--radius-md`
     - Title row: "3 files changed", `--text-xs`, uppercase, `--tracking-wide`, `--color-subtle`
     - File rows (buttons that open the diff): padding `--space-2 --space-3`, `FileCode` icon, path with ellipsis, `+N` in `--color-success`, `−N` in `--color-danger`
     - Dividers `--color-border-subtle`
   - **Handoff card:**
     - Padding `--space-4`, gap `--space-3`, `--color-border`, `--radius-md`, `--color-surface`
     - Tag "Handoff" with an `ArrowBendUpRight` icon, in `--color-agent-secondary`, then "to **ui-agent**"
     - Title: Hanken, `--text-lg`, semibold
     - Summary: `--text-sm`, `--color-muted`
     - "NEXT" label (field-label style) followed by the next step
     - Neutral `.button` (32px) "Open in Review" with an `ArrowUpRight` icon, deep-linking to the web Review page
   - **Actions row:** gap `--space-1`. Ghost icon buttons, 32px, `--radius-sm`, `--color-muted`; hover `--color-surface` + `--color-text`. `Copy` ("Copy response") and `ArrowClockwise` ("Retry"). Hide them while the message is streaming.
   - **Streaming:**
     - Text ends with the brand cursor block: `--brand-cursor-width` × `--brand-cursor-height`, `--color-accent`, static with no blinking loop (`DESIGN.md` forbids looping animation).
     - The existing "Responding…" status stays in `--color-warning`.
     - Stopped and failed states stay as they are today.

### Composer (`Composer`)
- Wrapper: unchanged `.chat-compose-area`. Box: `--space-3` padding, `--color-border`, `--radius-lg`, `--color-surface`, column, gap `--space-2`. Focus-within: `--color-border-strong`.
- **Attachments row** (only when attachments exist): chips 28px tall, padding `0 --space-1 0 --space-2`, `--color-selected`, `--radius-sm`, `--text-sm`. Each chip: `FileCode` icon, filename, and a 20px `X` remove button.
- **Textarea:** unchanged behavior (Enter sends, Shift+Enter adds a newline, `field-sizing: content`).
  - Placeholder "Message desktop-chat" (uses the agent name).
  - In the empty state: "Ask desktop-chat to work on listings-web".
- **Toolbar row** (gap `--space-2`, centered):
  - `Paperclip` ghost button (32px, "Attach files or context")
  - A 1px × 16px `--color-border` divider
  - Three ghost picker chips (28px, padding `0 --space-2`, `--text-sm`, `--color-muted`, hover `--color-glass-hover`):
    1. project (`FolderSimple` + name + `CaretDown`)
    2. agent (`Robot`, `--color-agent-secondary`)
    3. environment (6px status dot + name + caret)
  - A spacer, then Send or Stop:
    - Send: `.button.primary.composer-submit` (40px, `--radius-md`, `ArrowUp` bold)
    - Stop: `.button.danger.composer-submit` (`Square` fill)
- Pickers open the shared `Select`/menu. Environment options come from `GET /api/run-boxes?projectId=` and show their status words.

### Empty state (new chat)
- Grid rows stay as today (`.main[data-empty="true"]`), so the composer sits near vertical center.
- Remove the "What can I help with?" heading.
- Above the composer: a centered row of three **bordered** picker chips (32px, padding `0 --space-3`, `--color-border`, `--radius-sm`, `--color-surface`, hover `--color-border-strong` + `--color-selected`), each with a trailing caret. Environment shows its status dot and word.
- Below the chips: "Replies come from this project's agent via AgentCloud." in `--text-xs` `--color-subtle`.
- In the empty state, the composer toolbar shows only Attach and Send. The pickers move into the toolbar after the first message.
- Header title: "New chat". The context strip is hidden.

## Interactions & behavior
- Clicking a thread selects it (as today). Streaming threads show the amber dot until `done` or `status`.
- New chat opens the empty state.
- The tool-step toggle is per message and not persisted. Its default is collapsed.
- Copy copies the raw markdown. Retry re-sends the previous user message to the same agent.
- Code block Copy copies only the code.
- Motion: hover transitions use `--duration-fast`/`--duration-normal` with `--ease-standard`. Expanding tool steps may fade using `--duration-enter`. Respect `prefers-reduced-motion`.
- Narrow windows (≤768px): the history stays in the existing focus-managed drawer. The context strip collapses to the environment segment only. Composer picker labels truncate.

## State
- Existing: `threads`, `selectedId`, `activeThread`, `chatProjectId`, `drafts`, `sending`.
- New:
  - `threadQuery: string`
  - `chatAgentId: string | null`
  - `chatRunBoxId: string | null`, plus its status from polling run-boxes
  - `attachments` per draft key
  - `expandedSteps: Set<messageId>`
- Messages need structured parts beyond plain `content`:
  - `{type:"text", markdown}`
  - `{type:"tool", steps:[{cmd, result, ok}], durationMs, status:"running"|"done"|"failed", outputTail?}`
  - `{type:"files", files:[{path, additions, deletions}]}`
  - `{type:"handoff", to, title, summary, next, id}`
  - `{type:"env", runBoxId, status}`
- Each message also records `agentId`/`agentName` and `runBoxName`.
- Render only the parts the backend actually sends. Never fabricate command results.

## Design tokens used (from `app/tokens.css`)
- **Surfaces:** bg #090b0f, surface #12151b, selected #1c222b, raised #252c36
- **Text:** text #e6e9ef, muted #adb5c2, subtle #9ca5b3
- **Borders:** paper at 14% / 8% / 20%
- **Accent:** #77a7ff (hover #b5d0ff, soft #192d4b)
- **Agent secondary:** #a3b8d8 (soft #263141)
- **Status:** success #a1c9b3 (soft #243c32), warning #ddbd86, danger #e6a098 (soft #422b2c)
- **Glass:** fill rgb(18 21 27/90%), hover 6% paper, selected rgb(119 167 255/12%), edge 9% paper
- **Type:**
  - Hanken Grotesk for headings; JetBrains Mono for body
  - Sizes: xs 11, sm 12, base 13, lg 15, xl 18, 2xl 24
  - Line-heights: 1.15 / 1.6 / 1.8
  - Tracking: −0.03em / 0.1em
- **Spacing:** 4px scale (`--space-1` … `--space-8`)
- **Radii:** xs 4, sm 8, md 12, lg 16, navigation 12, full
- **Sizes:** control 40, small control 32, header 56, content-narrow 736, dot 6, avatar 32
- **Possible new tokens:** a 24px agent-avatar size, a 28px toolbar-chip height, and inline-code padding. Add them to `tokens.css` with a semantic name rather than hardcoding.

## Assets
- Icons are Phosphor (`@phosphor-icons/react`, already a dependency): NotePencil, MagnifyingGlass, FolderSimple, Robot, HardDrives, TerminalWindow, Check, CaretDown, CaretUp, Copy, ArrowClockwise, FileCode, ArrowBendUpRight, ArrowUpRight, Paperclip, X, ArrowUp, Square (fill), SignOut, ListChecks, ChatCircle.
- Fonts are the existing self-hosted ones in `public/fonts`.

## Files in this bundle
- `Project Chat.dc.html`: the interactive reference.
  - Frame **2a** is the redesign. Its state tabs switch between Empty, Active and Streaming, and clicking a thread also switches state.
  - Frame **1a** is the current UI.
- `support.js`: the runtime needed to open the reference in a browser.
- `public/fonts/`: fonts used by the reference.
