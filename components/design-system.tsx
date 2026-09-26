"use client";

import Link from "next/link";
import { useState } from "react";

const colors = [
  ["bg", "Canvas", "The working room"],
  ["surface", "Surface", "A distinct group"],
  ["surface-raised", "Raised", "Controls and layers"],
  ["text", "Text", "Primary information"],
  ["muted", "Muted", "Supporting context"],
  ["subtle", "Subtle", "Quiet metadata"],
  ["accent", "Cyan", "Actions and focus"],
  ["pink", "Magenta", "Agent identity"],
  ["success", "Success", "Healthy and complete"],
  ["warning", "Warning", "Attention required"],
] as const;
const typography = [
  ["hero", "A room for your team.", "Screen headline"],
  ["3xl", "Context travels with the work.", "Section headline"],
  ["xl", "Build the integration together.", "Panel heading"],
  ["base", "Codex published the API. Claude can start the frontend.", "Body copy"],
  ["sm", "backend/api · ready for handoff", "Supporting text"],
  ["xs", "Last activity just now", "Short metadata"],
] as const;
const spacing = [1, 2, 3, 4, 6, 8, 12, 16, 24] as const;

export default function DesignSystem() {
  const [action, setAction] = useState("Try a control to inspect its interaction state.");
  return (
    <div className="ds-page">
      <header className="ds-header">
        <Link className="brand" href="/projects">agentcloud<span>_</span></Link>
        <span className="tag cyan">Design reference</span>
        <Link className="ds-back" href="/projects">Back to projects ↗</Link>
      </header>
      <main className="ds-main">
        <section className="ds-intro" aria-labelledby="design-title">
          <div className="eyebrow">One source of truth · app/tokens.css</div>
          <h1 id="design-title">Built from tokens<span className="cursor">_</span></h1>
          <p>A shared visual language for a shared workspace. Every color, space, and interface state starts with a named purpose.</p>
          <nav className="ds-jump" aria-label="Design system sections">
            <a href="#palette">Palette</a><a href="#typography">Typography</a><a href="#spacing">Spacing</a><a href="#components">Components</a><a href="#contract">Contract</a>
          </nav>
        </section>

        <section className="ds-section" id="palette" aria-labelledby="palette-title">
          <div className="ds-section-title"><h2 id="palette-title">Color with a purpose</h2><p>Primitives define the palette. Semantic aliases define the interface.</p></div>
          <div className="ds-swatches">
            {colors.map(([name, label, description]) => (
              <article className="ds-swatch" key={name}>
                <div className={`ds-color ds-color-${name}`} aria-hidden="true" />
                <div className="ds-swatch-caption"><h3>{label}</h3><code>--color-{name}</code><p>{description}</p></div>
              </article>
            ))}
          </div>
          <p className="ds-caption">Pair each operational color with its soft surface. Always include a visible status label.</p>
        </section>

        <section className="ds-section" id="typography" aria-labelledby="type-title">
          <div className="ds-section-title"><h2 id="type-title">A working typeface</h2><p>JetBrains Mono with local monospace fallbacks. One family, clear hierarchy.</p></div>
          <div className="ds-type-list">
            {typography.map(([size, sample, purpose]) => (
              <div className="ds-type-row" key={size}><div className="ds-type-meta"><code>--text-{size}</code><span>{purpose}</span></div><p className={`ds-type-${size}`}>{sample}</p></div>
            ))}
          </div>
        </section>

        <section className="ds-section" id="spacing" aria-labelledby="spacing-title">
          <div className="ds-section-title"><h2 id="spacing-title">Space makes the hierarchy</h2><p>A four-pixel base. Compact within a group; generous between groups.</p></div>
          <div className="ds-spacing">
            {spacing.map(step => <div className="ds-space-row" key={step}><code>--space-{step}</code><div className={`ds-space-bar ds-space-${step}`} aria-hidden="true"/><span>{step * 4}px</span></div>)}
          </div>
          <p className="ds-caption">Values shown are the base scale at a 16px root. The implementation uses rem units.</p>
        </section>

        <section className="ds-section" id="components" aria-labelledby="component-title">
          <div className="ds-section-title"><h2 id="component-title">States, not decoration</h2><p>Shared controls keep every workflow familiar. Use Tab to inspect focus.</p></div>
          <div className="ds-component-grid">
            <article className="ds-specimen"><h3>Actions</h3><div className="ds-control-row"><button className="button primary" onClick={() => setAction("Primary action activated.")}>Primary action</button><button className="button" onClick={() => setAction("Secondary action activated.")}>Secondary</button><button className="button ghost" onClick={() => setAction("Quiet action activated.")}>Quiet action</button><button className="button" disabled>Unavailable</button></div><output className="ds-action-result" aria-live="polite">{action}</output></article>
            <article className="ds-specimen"><h3>Operational status</h3><div className="ds-control-row"><span className="tag cyan">● Working</span><span className="tag green">● Healthy</span><span className="tag yellow">● Waiting</span><span className="tag pink">● Needs review</span><span className="tag">○ Offline</span></div><p className="ds-caption">Agent identity stays separate from operational state. A label gives color its meaning.</p></article>
          </div>
        </section>

        <section className="ds-contract" id="contract" aria-labelledby="contract-title">
          <div><span className="tag green">Enforced in code</span><h2 id="contract-title">A contract, not a mood board.</h2><p>Components use semantic tokens. Raw visual values and token definitions belong only in the central stylesheet.</p></div>
          <div className="ds-contract-files"><code>app/tokens.css</code><span>Palette, scales, semantic aliases</span><code>DESIGN.md</code><span>Rules, exceptions, and review criteria</span><code>npm run tokens:check</code><span>Check application styles against the contract</span></div>
        </section>
      </main>
      <footer className="ds-footer"><span>AgentCloud · Design system</span><span>Quiet chrome. Visible collaboration.</span></footer>
    </div>
  );
}
