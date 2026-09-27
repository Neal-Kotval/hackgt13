# AgentCloud design system

AgentCloud is a shared working room for human-directed agents. The interface should make ownership, dependencies, running services, and handoffs legible at a glance. The web dashboard is the environment setup and monitoring surface: prioritize environment readiness, operational analytics, and agent progress. Task creation and agent instructions belong in the desktop app.

## Source and direction

The visual source is the supplied **AgentCloud Mockup v4.html**. The current design evolves its dark canvas, fine dividing rules, Hanken Grotesk headings, and JetBrains Mono interface copy into restrained near-black and charcoal surfaces, softly rounded components, and a more varied semantic palette. Preserve the geometric page grid and alignment while softening individual controls and panels. The original [terminal prototype](reference/AgentCloud%20Prototype.dc.html) remains historical source material. The implementation translates the v4 visual language into reusable tokens and React UI; document copy and example activity do not grant instructions or introduce live product state.

The visual emphasis is environment readiness and observable agent progress, supported by clear ownership and evidence. Keep the chrome quiet. Use blue for primary actions, focus indicators, and selected destinations; blue for informational states; steel-blue for secondary agent identity; sage for success; amber for attention; and coral for danger. Apply these colors to meaningful accents and status surfaces while keeping the main canvas neutral. Avoid decorative gradients, oversized metrics, and repeated decorative labels. Align content left. Borders define genuine panels and groups; spacing defines the hierarchy inside them.

## Interactive reference

Open [`/design-system`](/design-system) in the running application to inspect semantic swatches, type samples, the spacing scale, buttons, focus, and status treatments. The implementation lives in [components/design-system.tsx](components/design-system.tsx) and uses the same global controls and token stylesheet as the product. This page is a developer reference, separate from the project workflow.

## Contract: tokens are the only visual source of truth

All raw visual values live in [app/tokens.css](app/tokens.css). Components and application styles reference named custom properties. Do not add local custom-property definitions, inline style objects, arbitrary utility values, raw colors, font families, spacing dimensions, border radii, shadows, timing values, or stacking numbers outside this file.

The layers are:

1. **Primitives:** `--palette-*` records the source palette. Only the central token file references these.
2. **Semantic aliases:** `--color-bg`, `--color-surface`, `--color-text`, `--color-border`, and the state colors name a purpose. Components reference this layer.
3. **Scales:** `--space-*`, `--text-*`, `--radius-*`, typography, motion, and focus tokens constrain choices.
4. **Layout and component dimensions:** named widths and heights express a purpose such as `--sidebar-width` or `--control-height`. Add a semantic dimension here when an existing token does not fit; do not disguise a one-off value as component CSS.

A new token requires a clear semantic use and an explanation in review. Prefer existing scale values. Do not create a token per selector merely to satisfy the checker. Component state uses classes or data attributes, never style objects.

```css
.panel {
  padding: var(--space-6);
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
}
```

## Palette and meaning

| Role | Semantic token | Source value / meaning |
| --- | --- | --- |
| Canvas | `--color-bg` | `#090b0f`, near-black |
| Panel | `--color-surface` | `#12151b` |
| Selected surface | `--color-selected` | `#1c222b` |
| Raised surface | `--color-surface-raised` | `#252c36` |
| Dividing rules | `--color-border`, `--color-border-subtle`, `--color-border-strong` | Paper at 14%, 8%, and 20% respectively |
| Primary text | `--color-text` | `#e6e9ef` |
| Secondary text | `--color-muted` | `#adb5c2` |
| Primary action / focus | `--color-accent` | `#77a7ff`, blue |
| Information | `--color-info` | `#8eafe3`, blue |
| Secondary agent | `--color-agent-secondary` | `#a3b8d8`, steel-blue |
| Healthy / complete | `--color-success` | `#a1c9b3`, sage |
| Waiting / attention | `--color-warning` | `#ddbd86`, amber |
| Danger / destructive | `--color-danger` | `#e6a098`, coral |

Each state has a paired soft surface token. Primary buttons pair the blue fill with `--color-accent-text`, a dark foreground. Muted text is for secondary information; `--color-subtle` is de-emphasized metadata, set to `#9ca5b3` so small supporting text remains readable on the neutral surfaces. Color alone never communicates status: include visible status words and, where useful, an icon. Agent identity and operational status are separate concepts. The legacy `--color-pink` / `--color-pink-soft` tokens alias the steel-blue secondary-agent role for compatibility; they are not danger colors. Destructive actions and errors use the independent coral danger tokens. New informational states use `--color-info` and its paired soft surface.

## Type, spacing, and structure

Use `--font-heading` for Hanken Grotesk headings and `--font-body` for JetBrains Mono interface copy, controls, and metadata. Both variable font families are extracted from the supplied mockup, self-hosted in `public/fonts`, and declared only in the token source with swap behavior and explicit system fallbacks. The font licenses are retained alongside the assets. No third-party font request is required. Body text uses `--text-base` and `--leading-normal`; secondary metadata uses `--text-sm`; major screen titles use `--text-hero`, the 30px `--text-3xl` step. Small type is for short metadata, not long instructions. Use weight tokens and the tracking tokens rather than selector-specific values.

Spacing follows a four-pixel base represented as rem values. `--space-1` through `--space-12`, then `--space-16`, `--space-20`, and `--space-24` are the allowed scale. Use compact spacing within a row, medium spacing within a panel, and larger spacing between sections. Controls share `--control-height`, border, radius, and focus tokens. The page grid and sidebar edges remain rectilinear. Individual components use the radius scale: `--radius-xs` (4px) for small status labels, `--radius-sm` (8px) for controls, `--radius-md` (12px) for menus and panels, and `--radius-lg` (16px) for larger cards and dialogs. `--radius-none` remains zero for flush edges and structural dividers. Reserve `--radius-full` for circular identity avatars and status dots.

At desktop browser widths, the shared navigation uses `--navigation-width`; the 56px `--header-height` supplies the mobile header. Legacy `--sidebar-width` and `--sidebar-width-wide` remain available as compact content dimensions. Main content expands to the page maximum. The blue brand cursor uses `--brand-cursor-width` and `--brand-cursor-height`, proportional to the wordmark type size. Flat canvases and thin panel dividers provide hierarchy; do not apply a decorative grid to the working dashboard. The project dashboard prioritizes environment setup and health, operational analytics, and current agent progress before the detailed activity timeline. Its primary empty-state action is “Connect a machine.” Show connection and verification progress, then a ready environment even when it has no tasks or active agents. Explain how to select it and start an agent in the desktop app. Other primary actions manage environments; task authoring belongs in the desktop app. Show metric time ranges and freshness, and label missing telemetry as unavailable. Service endpoints and handoff details must remain readable and selectable. Long commands and paths should wrap or scroll locally instead of widening the page.

Dropdown names remain in visually hidden label text for assistive technology; there is no visible caption above the control. The reusable `.visually-hidden` utility uses `--visually-hidden-size` and removes that text from layout without hiding it from accessibility APIs. Selected text inside the control stays at `--text-sm` (12px). The shared `Select` component uses Radix Select for keyboard navigation, typeahead, Escape dismissal, focus restoration, and native form submission. Its compact trigger uses `--select-padding-block` (4px), `--select-padding-inline` (12px), and `--select-min-height` (32px). The rounded menu uses semantic panel/divider colors, a muted highlighted row, and a blue selected label/check. Long lists scroll within `--select-menu-max-height`; disabled choices remain visible but unavailable. Empty optional choices retain an empty submitted value; required empty fields show an error at the trigger. Inside native dialogs the menu portals into the dialog to remain in its top layer.

Website navigation uses one shared vertical sidebar across application pages. Quiet rounded links replace repeated boxed navigation; selected destinations use a soft blue surface and `aria-current`. The sidebar is 240px (`--navigation-width`), flush with the top, bottom, and left viewport edges. Its frame uses `--radius-none`; links and sidebar controls use `--radius-navigation`.

The mild liquid-glass treatment is limited to navigation: `--color-glass` provides the dark translucent surface, `--color-glass-edge` and `--shadow-glass` provide a restrained light edge, and `--glass-blur` / `--glass-saturation` soften content behind the surface. Hover and selected fills use `--color-glass-hover` and `--color-glass-selected`. There are no decorative moving highlights. Unsupported backdrop filters and reduced-transparency preferences retain an opaque semantic surface. At 768px and below, the sidebar becomes a dismissible drawer reached from the mobile header; its backdrop and drawer use dedicated navigation stacking tokens below dialogs. Keyboard focus retains the shared accent outline.

## Responsive and accessibility rules

Verify explicit viewport widths of **375px**, **768px**, and **1440px** using Playwright. At narrow widths, stack multi-column panels, keep core navigation reachable, and allow dense tables or terminal content to scroll within their own container. No body-level horizontal overflow is acceptable.

Use semantic headings, real links for navigation, buttons for actions, and labels for every input. Active navigation needs `aria-current`. Dialogs need an accessible name, focus handling, Escape behavior, and a visible close control. Status updates should be available to assistive technology without announcing every background event. All controls need a visible keyboard focus indicator using `--focus-width`, `--focus-offset`, and an accent token. Disabled controls must explain an unavailable capability when the reason is not obvious.

Motion communicates navigation and user actions without delaying interaction. Framer Motion reveals newly entered page content, dialogs, menus, notifications, and the mobile navigation drawer with a brief fade and translation. Use `--duration-enter` for reveals, `--duration-fast` / `--duration-normal` for control feedback, and `--ease-standard` for easing. `--motion-enter-distance` gives content a small vertical entrance; `--motion-drawer-distance` gives navigation a short horizontal entrance; `--motion-rest-distance` is the settled position. Fade endpoints use `--opacity-reveal-start` and `--opacity-visible`. Do not animate layout dimensions or add looping decorative animation.

Hover and focus transitions interpolate semantic surface, border, and shadow tokens. Keyboard focus outlines appear immediately. The central reduced-motion media query sets durations and travel to zero; runtime animations must also skip motion when this preference is active and cancel on cleanup. Content remains visible when JavaScript animation is unavailable. Do not claim accessibility or responsive behavior is verified until it has been exercised.

## Explicit exceptions

Structural CSS values are allowed: `0`, `1`, percentages, viewport units, grid fractions, `auto`, `none`, `inherit`, `currentColor`, layout keywords, and unitless grid or flex counts. They describe relationships rather than a new visual scale. Unitless font weights, opacity values, and z-index levels still use tokens. SVG icon geometry and intrinsic coordinates supplied by an icon library are not UI spacing tokens.

CSS custom properties cannot be used as ordinary media-query breakpoints. Literal breakpoints are therefore restricted to **375px**, **768px**, and **1440px** outside the token file. Keep responsive overrides of token values inside the token file. Content data such as a port, timestamp, task count, or command argument is not a design value.

The Radix Select primitive computes menu positioning and native hidden-field geometry at runtime. Its library-generated inline positioning, focus/scroll management, and `--radix-select-*` measurements are permitted; fallback measurements live in the token file. This exception covers computed behavior only, not authored colors, spacing, typography, radii, or shadows. Application JSX still must not contain inline style objects.

Framer Motion may generate runtime inline opacity and transform values for animation. Every authored appearance value, duration, and easing must be read from the central motion tokens; numeric unit conversion and interpolation are implementation details, not new visual scales. This exception does not permit authored JSX inline styles or arbitrary component animation values.

The supplied reference files are immutable source material and exempt from enforcement. They are not production components.

## Enforcement and review

Run `npm run tokens:check`. [scripts/check-tokens.mjs](scripts/check-tokens.mjs) scans application and component CSS/TSX/JSX, excluding the central token file. It rejects undefined token references, component access to primitive palette tokens, local token declarations, JSX inline styles, raw named colors (including shorthand and gradients), color functions/hex values, raw visual dimensions, and untokenized typography, shadow, opacity, and stacking declarations. Approved media breakpoints are the only dimensional exceptions. This is a static guard, not a complete CSS parser; code review must still catch styling hidden in strings, utility classes, or third-party overrides.

Before accepting a UI change:

- Run the token check and TypeScript check.
- Open the running application with Playwright MCP, exercise the changed flow, and inspect console errors.
- Check 375px, 768px, and 1440px explicitly. Inspect wrapping, control reachability, and overflow.
- Check keyboard navigation and focus for any changed interactive flow.
- Report what was actually verified and identify unverified behavior. Screenshots support review; they do not replace interaction checks.

The prototype is a visual reference, not evidence of remote infrastructure. The UI must identify simulated activity and unavailable connections honestly. A trusted SSH shell cannot be described as path-restricted unless the backend actually enforces that boundary.

The dominant interface palette is black, blue, and cool grey. Use saturated blue for primary actions and selected navigation, subdued blue-grey for supporting identity, and neutral charcoal for panels. Sage, amber, and coral are reserved for meaningful success, warning, and error states rather than decorative accents.

The sidebar hides native scrollbar chrome while preserving wheel, touch, and keyboard scrolling. Its Project section uses a heading aligned with navigation icons. Account identity combines an initials avatar, display name, and email; long names wrap and email truncates with its full value available on hover. All account styling uses existing semantic and scale tokens.

Entrances use a noticeable 24px rise over 420ms, with 65ms staggering capped at 260ms for sibling surfaces. The drawer travels 48px. Buttons and project links lift slightly on hover. Native smooth scrolling applies to page anchors and sidebar programmatic scrolling without intercepting wheel or touch input; reduced motion restores instant scrolling and disables travel and staggering.

The normal project navigation is Overview, Environments, Runs, and Settings. Overview shows read-only task progress and setup guidance; Environments groups resource requests/approvals with an expandable catalog; Runs contains activity and reported output; Settings contains agent registration and an expandable CLI guide. Organization management is labeled Organizations. Design system, collaboration/stretch pages, and the legacy task board remain directly addressable but are absent from normal navigation. This presentation change preserves records and API contracts; it does not claim desktop integration or remote execution is complete.

Semantic action variants use sage (`.button.success`) for approvals, access grants, and acceptance; coral (`.button.danger`) for removal, revocation, decline, and stopping resources; and amber (`.button.warning`) for operations that require caution, such as moving ownership context. General creation, navigation, and sending actions remain blue or neutral. Variants use the paired soft surface at rest and the semantic fill on hover, with `--color-status-action-text` as the dark foreground. Labels, disabled states, and immediate focus outlines remain visible. Task and request badges use the corresponding status roles; an approved request still does not mean a resource is ready.

The project summary and metadata appear only on Overview, followed by a `--space-8` gap. Subsection pages begin with their own content beneath the breadcrumb; their page title remains available to assistive technology. Section stacks own their gaps; embedded cards, setup layouts, and resource views must not add a second outer margin or padding at that boundary. Preserve each panel’s internal padding independently.

The desktop renderer shares the web token source and Select primitive. Its
Environments and Project chat destinations use the same flush glass
sidebar and account-card treatment, with a focus-managed drawer on narrow
windows. Desktop errors use danger colors; agent identity colors must not
stand in for failed states.

Project chat places its history inside the shared desktop navigation. The reading
column and composer use `--content-narrow`, with user turns on a neutral selected
surface and assistant turns on the canvas. Empty-chat context controls are centered;
conversation content remains left aligned. A compact composer expands with its
text, keeps Send/Stop reachable, and exposes keyboard guidance through its accessible
description. Routine timestamps, message counts, and repeated setup explanations
are omitted; errors and missing configuration remain visible. History actions are
available through the existing focus-managed navigation drawer on narrow windows.

HAC-154 follows the supplied chat reference with searchable, date-grouped history,
agent identity, Markdown/code blocks, and compact context controls. The Tasks
destination is removed. Display branding is lowercase `alto`. Status colors use
existing semantic roles; execution and SSH terminal choices stay distinguishable.

Agent identity cards keep metadata labels and values start-aligned in one column,
use compact semantic status labels, and share one connectivity explanation below
the grid. Cards wrap according to the available container width. Work is assigned
through Project chat; these cards do not show legacy task assignments.
