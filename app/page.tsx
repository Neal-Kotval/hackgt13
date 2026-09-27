import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, GitBranch, HardDrives, UsersThree } from "@phosphor-icons/react/dist/ssr";
import "./marketing.css";

export const metadata: Metadata = {
  title: "alto — let agents soar",
  description: "Give coding agents a place to work on approved infrastructure. Direct the project, disconnect, and return to the same work.",
};

const strengths = [
  {
    icon: <HardDrives aria-hidden="true" />,
    title: "A real place to work",
    text: "Select a verified environment for your project. Give the agent files, tools, and compute where the work actually runs.",
  },
  {
    icon: <UsersThree aria-hidden="true" />,
    title: "A project you can direct",
    text: "Keep instructions, ownership, activity, and handoffs connected as more agents contribute.",
  },
  {
    icon: <GitBranch aria-hidden="true" />,
    title: "Context you can return to",
    text: "Reopen the project and its conversation. Follow the recorded work instead of rebuilding context from scattered sessions.",
  },
];

export default function MarketingPage() {
  return <main className="marketing" id="top">
    <a className="marketing-skip" href="#main-content">Skip to content</a>
    <header className="marketing-header">
      <Link className="marketing-wordmark" href="/" aria-label="alto home">alto<span aria-hidden="true">.</span></Link>
      <nav aria-label="Main navigation">
        <a href="#platform">Platform</a>
        <a href="#how-it-works">How it works</a>
        <a href="#roadmap">What&apos;s next</a>
      </nav>
      <Link className="marketing-header-action" href="/app">Open app <ArrowUpRight aria-hidden="true" /></Link>
    </header>

    <section className="marketing-hero" id="main-content" aria-labelledby="hero-title">
      <div className="marketing-hero-copy">
        <p className="marketing-kicker">For engineering teams building with agents</p>
        <h1 id="hero-title">Let agents<br />soar<span>.</span></h1>
        <p className="marketing-intro">Give coding agents a place to work on infrastructure your team approves. Direct the project from your laptop, disconnect, and come back to the same work.</p>
        <div className="marketing-actions">
          <Link className="marketing-button marketing-button-primary" href="/sign-up">Create an account <ArrowUpRight aria-hidden="true" /></Link>
          <a className="marketing-button marketing-button-secondary" href="#platform">Explore the platform <ArrowRight aria-hidden="true" /></a>
        </div>
      </div>
    </section>

    <section className="marketing-showcase" id="platform" aria-labelledby="showcase-title">
      <div className="marketing-showcase-copy"><p className="marketing-kicker">The alto workspace</p><h2 id="showcase-title">Let the work outlast your laptop.</h2><p>Your laptop is the control surface. The agent works in a selected environment, with project context and resources your team has approved.</p></div>
      <div className="marketing-hero-art" aria-label="Concept diagram showing a laptop directing an agent in a project environment, with approved resources and a place to return to the work" role="img">
        <div className="marketing-art-top"><span>One project workspace</span><span>alto / environment</span></div>
        <div className="marketing-art-stage">
          <div className="marketing-art-source"><span className="marketing-art-symbol">✳</span><span>You direct the work</span></div>
          <div className="marketing-art-track" aria-hidden="true"><span /><span /><span /></div>
          <div className="marketing-art-agent marketing-art-agent-one"><span className="marketing-art-symbol">↗</span><span>Agent workspace</span><small>Files + conversation</small></div>
          <div className="marketing-art-agent marketing-art-agent-two"><span className="marketing-art-symbol">↗</span><span>Approved resources</span><small>Compute + tools</small></div>
          <div className="marketing-art-outcome"><Check aria-hidden="true" /><span>Return to the work</span></div>
        </div>
        <div className="marketing-art-bottom"><span>Connect</span><span>Work</span><span>Return</span></div>
      </div>
    </section>

    <section className="marketing-platform" aria-labelledby="platform-title">
      <div className="marketing-section-heading"><p className="marketing-kicker">The platform</p><h2 id="platform-title">A home for the agent. A clear view for the team.</h2><p>Real engineering work needs a real environment. alto brings the machine, project, and people into one workflow.</p></div>
      <div className="marketing-strengths">{strengths.map(item => <article className="marketing-strength" key={item.title}><div className="marketing-strength-icon">{item.icon}</div><h3>{item.title}</h3><p>{item.text}</p></article>)}</div>
    </section>

    <section className="marketing-flow" id="how-it-works" aria-labelledby="flow-title">
      <div className="marketing-flow-intro"><p className="marketing-kicker">The workflow we are building</p><h2 id="flow-title">Connect. Direct. Return.</h2><p>Start with an approved place for the work to run. Give the agent a project, then keep its context available when you step away.</p></div>
      <ol className="marketing-steps"><li><span>01</span><div><h3>Connect an environment</h3><p>Choose a machine your team controls and verify that it is ready for the agent.</p></div></li><li><span>02</span><div><h3>Start work remotely</h3><p>Direct the agent in the project environment, close to the files and resources it needs.</p></div></li><li><span>03</span><div><h3>Pick up where you left off</h3><p>Reconnect to the project conversation and inspect the work tied to it.</p></div></li></ol>
    </section>

    <section className="marketing-roadmap" id="roadmap" aria-labelledby="roadmap-title"><div><p className="marketing-kicker">Today and next</p><h2 id="roadmap-title">A real computer for every agent.</h2></div><div><p>Today, alto can verify Docker and Runpod environments and run Codex in a selected ready environment over SSH. Project chat saves conversation history. We are extending that foundation to existing Linux machines, dependable long-running work, and shared resources across agents.</p><Link href="/sign-up">Start with alto <ArrowUpRight aria-hidden="true" /></Link></div></section>

    <footer className="marketing-footer"><Link className="marketing-wordmark" href="/">alto<span aria-hidden="true">.</span></Link><p>Let agents soar.</p><div><Link href="/sign-in">Sign in</Link><Link href="/sign-up">Create an account</Link><a href="#top">Back to top</a></div></footer>
  </main>;
}
