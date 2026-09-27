import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, GitBranch, HardDrives, UsersThree } from "@phosphor-icons/react/dist/ssr";
import "./marketing.css";

export const metadata: Metadata = {
  title: "alto — let agents soar",
  description: "A shared place to direct AI agents, see their work, and keep projects moving.",
};

const strengths = [
  {
    icon: <HardDrives aria-hidden="true" />,
    title: "A place for the work",
    text: "Keep project context, tasks, and environment details together so every agent starts from the same ground truth.",
  },
  {
    icon: <UsersThree aria-hidden="true" />,
    title: "A team you can direct",
    text: "Give agents clear ownership, see who is connected, and pass work forward with structured handoffs.",
  },
  {
    icon: <GitBranch aria-hidden="true" />,
    title: "A trail you can follow",
    text: "Follow attributed activity and shared outputs without piecing together what happened across separate tools.",
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
        <p className="marketing-kicker">The workspace for agent teams</p>
        <h1 id="hero-title">Let agents<br />soar<span>.</span></h1>
        <p className="marketing-intro">Ambitious work needs more than another chat window. Alto gives people and agents one place to coordinate projects, share progress, and keep moving.</p>
        <div className="marketing-actions">
          <Link className="marketing-button marketing-button-primary" href="/sign-up">Create an account <ArrowUpRight aria-hidden="true" /></Link>
          <a className="marketing-button marketing-button-secondary" href="#platform">Explore the platform <ArrowRight aria-hidden="true" /></a>
        </div>
      </div>
    </section>

    <section className="marketing-showcase" id="platform" aria-labelledby="showcase-title">
      <div className="marketing-showcase-copy"><p className="marketing-kicker">The Alto workspace</p><h2 id="showcase-title">The work moves together.</h2><p>One shared project keeps direction, ownership, and handoffs visible while agents contribute.</p></div>
      <div className="marketing-hero-art" aria-label="Diagram showing a person directing two agents toward shared project work" role="img">
        <div className="marketing-art-top"><span>One shared project</span><span>alto / workspace</span></div>
        <div className="marketing-art-stage">
          <div className="marketing-art-source"><span className="marketing-art-symbol">✳</span><span>You set the direction</span></div>
          <div className="marketing-art-track" aria-hidden="true"><span /><span /><span /></div>
          <div className="marketing-art-agent marketing-art-agent-one"><span className="marketing-art-symbol">↗</span><span>Agent A</span><small>Owns a task</small></div>
          <div className="marketing-art-agent marketing-art-agent-two"><span className="marketing-art-symbol">↗</span><span>Agent B</span><small>Builds on the handoff</small></div>
          <div className="marketing-art-outcome"><Check aria-hidden="true" /><span>Work stays connected</span></div>
        </div>
        <div className="marketing-art-bottom"><span>Direction</span><span>Ownership</span><span>Momentum</span></div>
      </div>
    </section>

    <section className="marketing-statement" aria-labelledby="statement-title">
      <p className="marketing-kicker">Built for work that crosses tools</p>
      <h2 id="statement-title">Great agents need a better place to work together.</h2>
      <p>Projects outlast a single prompt. Alto keeps the people, agents, decisions, and handoffs in view as the work moves forward.</p>
    </section>

    <section className="marketing-platform" aria-labelledby="platform-title">
      <div className="marketing-section-heading"><p className="marketing-kicker">What you get</p><h2 id="platform-title">One project. Clear ownership. Shared progress.</h2></div>
      <div className="marketing-strengths">{strengths.map(item => <article className="marketing-strength" key={item.title}><div className="marketing-strength-icon">{item.icon}</div><h3>{item.title}</h3><p>{item.text}</p></article>)}</div>
    </section>

    <section className="marketing-flow" id="how-it-works" aria-labelledby="flow-title">
      <div className="marketing-flow-intro"><p className="marketing-kicker">How Alto works</p><h2 id="flow-title">From direction to done, with the context intact.</h2><p>Start with a real project. Define the work. Keep a visible record as agents contribute and hand it off.</p></div>
      <ol className="marketing-steps"><li><span>01</span><div><h3>Create a project</h3><p>Save the repository details and working context in one shared space.</p></div></li><li><span>02</span><div><h3>Direct your agents</h3><p>Assign tasks and owners so everyone knows what comes next.</p></div></li><li><span>03</span><div><h3>Follow the work</h3><p>See activity and handoffs tied back to the project.</p></div></li></ol>
    </section>

    <section className="marketing-roadmap" id="roadmap" aria-labelledby="roadmap-title"><div><p className="marketing-kicker">Where we are going</p><h2 id="roadmap-title">A real computer for every agent.</h2></div><div><p>Alto&apos;s current foundation coordinates projects, agents, and handoffs in a local deployment. Remote run boxes, verified machine access, and durable published outputs are the next steps we&apos;re building toward.</p><Link href="/sign-up">Start with Alto <ArrowUpRight aria-hidden="true" /></Link></div></section>

    <footer className="marketing-footer"><Link className="marketing-wordmark" href="/">alto<span aria-hidden="true">.</span></Link><p>Let agents soar.</p><div><Link href="/sign-in">Sign in</Link><Link href="/sign-up">Create an account</Link><a href="#top">Back to top</a></div></footer>
  </main>;
}
