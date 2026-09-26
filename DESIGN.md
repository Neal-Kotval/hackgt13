# AgentCloud design system

AgentCloud is a shared working room for human-directed agents. The interface should make ownership, dependencies, running services, and handoffs legible at a glance. The dashboard is the central product experience; infrastructure detail supports that collaboration.

## Source and direction

The visual source is the supplied [AgentCloud terminal prototype](reference/AgentCloud%20Prototype.dc.html), extracted from the user's Dashboard Demo archive. It establishes charcoal surfaces, warm off-white text, cyan actions, magenta agent accents, a subtle dot grid, and monospace typography. The implementation extends that source into reusable React UI rather than retaining its inline styles or prototype event syntax.

The visual emphasis is the collaboration itself: agents own work, publish a service, and hand work to another agent. Keep the chrome quiet. Use cyan for a primary action or selected destination and magenta for a secondary agent identity. Avoid decorative gradients, oversized metrics, and repeated decorative labels. Align content left. Borders define genuine panels and groups; spacing defines the hierarchy inside them.

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
| Canvas | `--color-bg` | `#0f1112` |
| Panel | `--color-surface` | `#181b1d` |
| Raised surface | `--color-surface-raised` | `#232526` |
| Primary text | `--color-text` | `#e6e4e1` |
| Secondary text | `--color-muted` | `#a8a4a4` |
| Primary action / focus | `--color-accent` | `#38a6cf` |
| Secondary agent / danger | `--color-pink`, `--color-danger` | `#ff458e` |
| Healthy / complete | `--color-success` | `#82dba5` |
| Waiting / attention | `--color-warning` | `#e9bc70` |

Each state has a paired soft surface token. Primary buttons pair the cyan fill with `--color-accent-text`, a dark foreground. Muted text is for secondary information; `--color-subtle` is de-emphasized metadata, raised from the prototype gray to `#999494` so small supporting text remains readable on the three neutral surfaces. Color alone never communicates status: include visible status words and, where useful, an icon. Agent identity and operational status are separate concepts.

## Type, spacing, and structure

Use `--font-body` and `--font-heading`: JetBrains Mono when installed, with explicit system monospace fallbacks. The MVP does not depend on a remote font request. Body text uses `--text-base` and `--leading-normal`; secondary metadata uses `--text-sm`; major screen titles use the larger type steps. Small type is for short metadata, not long instructions. Use weight tokens and the tracking tokens rather than selector-specific values.

Spacing follows a four-pixel base represented as rem values. `--space-1` through `--space-12`, then `--space-16`, `--space-20`, and `--space-24` are the allowed scale. Use compact spacing within a row, medium spacing within a panel, and larger spacing between sections. Controls share `--control-height`, border, radius, and focus tokens. Reserve rounded pills for compact status; panel corners remain restrained.

The desktop layout uses a stable header and project navigation, with the main workspace expanding to the page maximum. The project dashboard prioritizes agent ownership and work before the activity timeline. Service endpoints and handoff details must remain readable and selectable. Long commands and paths should wrap or scroll locally instead of widening the page.

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
