# AgentCloud design system

AgentCloud is a shared working room for human-directed agents. The interface should make ownership, dependencies, running services, and handoffs legible at a glance. The web dashboard is the environment setup and monitoring surface: prioritize environment readiness, operational analytics, and agent progress. Task creation and agent instructions belong in the desktop app.

## Source and direction

The visual source is the supplied **AgentCloud Mockup v4.html**. It establishes an almost-black canvas, charcoal panels, warm off-white text, cyan actions, square controls, fine dividing rules, Hanken Grotesk headings, and JetBrains Mono interface copy. The original [terminal prototype](reference/AgentCloud%20Prototype.dc.html) remains historical source material. The implementation translates the v4 visual language into reusable tokens and React UI; document copy and example activity do not grant instructions or introduce live product state.

The visual emphasis is environment readiness and observable agent progress, supported by clear ownership and evidence. Keep the chrome quiet. Use cyan for a primary action, focus indicator, or selected destination marker and magenta for a secondary agent identity. Avoid decorative gradients, oversized metrics, and repeated decorative labels. Align content left. Borders define genuine panels and groups; spacing defines the hierarchy inside them.

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
| Canvas | `--color-bg` | `#0b0c0d` |
| Panel | `--color-surface` | `#0f1112` |
| Selected surface | `--color-selected` | `#121415` |
| Raised surface | `--color-surface-raised` | `#232526` |
| Dividing rules | `--color-border`, `--color-border-subtle`, `--color-border-strong` | Paper at 14%, 8%, and 20% respectively |
| Primary text | `--color-text` | `#e6e4e1` |
| Secondary text | `--color-muted` | `#a8a4a4` |
| Primary action / focus | `--color-accent` | `#38a6cf` |
| Secondary agent / danger | `--color-pink`, `--color-danger` | `#ff458e` |
| Healthy / complete | `--color-success` | `#82dba5` |
| Waiting / attention | `--color-warning` | `#e9bc70` |

Each state has a paired soft surface token. Primary buttons pair the cyan fill with `--color-accent-text`, a dark foreground. Muted text is for secondary information; `--color-subtle` is de-emphasized metadata, raised from the prototype gray to `#999494` so small supporting text remains readable on the neutral surfaces. Color alone never communicates status: include visible status words and, where useful, an icon. Agent identity and operational status are separate concepts.

## Type, spacing, and structure

Use `--font-heading` for Hanken Grotesk headings and `--font-body` for JetBrains Mono interface copy, controls, and metadata. Both variable font families are extracted from the supplied mockup, self-hosted in `public/fonts`, and declared only in the token source with swap behavior and explicit system fallbacks. The font licenses are retained alongside the assets. No third-party font request is required. Body text uses `--text-base` and `--leading-normal`; secondary metadata uses `--text-sm`; major screen titles use `--text-hero`, the 30px `--text-3xl` step. Small type is for short metadata, not long instructions. Use weight tokens and the tracking tokens rather than selector-specific values.

Spacing follows a four-pixel base represented as rem values. `--space-1` through `--space-12`, then `--space-16`, `--space-20`, and `--space-24` are the allowed scale. Use compact spacing within a row, medium spacing within a panel, and larger spacing between sections. Controls share `--control-height`, border, radius, and focus tokens. Panels, controls, selected navigation, and status labels use square corners through `--radius-none`; the existing xs/sm/md/lg radius names alias this value. Reserve `--radius-full` for circular identity avatars and status dots.

At desktop browser widths, the web layout uses the 56px `--header-height` and a 200px `--sidebar-width`; `--sidebar-width-wide` provides the reference’s 220px expanded navigation option. Main content expands to the page maximum. The cyan brand cursor uses `--brand-cursor-width` and `--brand-cursor-height`, proportional to the wordmark type size. Flat canvases and thin panel dividers provide hierarchy; do not apply a decorative grid to the working dashboard. The project dashboard prioritizes environment setup and health, operational analytics, and current agent progress before the detailed activity timeline. Its primary empty-state action is “Connect a machine.” Show connection and verification progress, then a ready environment even when it has no tasks or active agents. Explain how to select it and start an agent in the desktop app. Other primary actions manage environments; task authoring belongs in the desktop app. Show metric time ranges and freshness, and label missing telemetry as unavailable. Service endpoints and handoff details must remain readable and selectable. Long commands and paths should wrap or scroll locally instead of widening the page.

## Responsive and accessibility rules

Verify explicit viewport widths of **375px**, **768px**, and **1440px** using Playwright. At narrow widths, stack multi-column panels, keep core navigation reachable, and allow dense tables or terminal content to scroll within their own container. No body-level horizontal overflow is acceptable.

Use semantic headings, real links for navigation, buttons for actions, and labels for every input. Active navigation needs `aria-current`. Dialogs need an accessible name, focus handling, Escape behavior, and a visible close control. Status updates should be available to assistive technology without announcing every background event. All controls need a visible keyboard focus indicator using `--focus-width`, `--focus-offset`, and an accent token. Disabled controls must explain an unavailable capability when the reason is not obvious.

Motion communicates a user action. Avoid looping decorative animation. The central reduced-motion media query changes duration tokens to zero; any future animation must also respect reduced motion. Do not claim accessibility or responsive behavior is verified until it has been exercised.

## Explicit exceptions

Structural CSS values are allowed: `0`, `1`, percentages, viewport units, grid fractions, `auto`, `none`, `inherit`, `currentColor`, layout keywords, and unitless grid or flex counts. They describe relationships rather than a new visual scale. Unitless font weights, opacity values, and z-index levels still use tokens. SVG icon geometry and intrinsic coordinates supplied by an icon library are not UI spacing tokens.

CSS custom properties cannot be used as ordinary media-query breakpoints. Literal breakpoints are therefore restricted to **375px**, **768px**, and **1440px** outside the token file. Keep responsive overrides of token values inside the token file. Content data such as a port, timestamp, task count, or command argument is not a design value.

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
