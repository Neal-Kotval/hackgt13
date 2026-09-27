import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowBendUpRight, ArrowClockwise, ArrowUpRight, CaretDown, Check, Copy, FileCode, Robot, TerminalWindow } from "@phosphor-icons/react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "./CodexConversation.css";

/** Optional structured evidence. Renderers never infer these from assistant prose. */
export type CodexEventPart =
  | { type: "text"; markdown: string }
  | { type: "tool"; steps: { cmd: string; result?: string; ok?: boolean }[]; durationMs?: number; status: "running" | "done" | "failed"; outputTail?: string }
  | { type: "files"; files: { path: string; additions?: number; deletions?: number; diffUrl?: string }[] }
  | { type: "handoff"; to: string; title: string; summary: string; next: string; id: string; reviewUrl?: string }
  | { type: "env"; runBoxId: string; name?: string; status: string };

export type CodexEvent = {
  id: string;
  kind: "user" | "assistant" | "command" | "status" | "error";
  text: string;
  actorName?: string;
  agentName?: string;
  runBoxName?: string;
  parts?: CodexEventPart[];
  createdAt?: string;
  updatedAt: string;
};

type CodexConversationProps = {
  events: CodexEvent[];
  working: boolean;
  emptyLabel?: string;
  agentName?: string;
  environmentName?: string;
  emptyContent?: ReactNode;
  onRetry?: (eventId: string) => void;
  retryDisabled?: boolean;
};

function CopyButton({ text, label, compact = false }: { text: string; label: string; compact?: boolean }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus("copied"); }
    catch { setStatus("failed"); }
  }
  return <span className="codex-copy-control">
    <button type="button" className="codex-action" onClick={() => void copy()} aria-label={status === "copied" ? "Copied" : label} title={label}>
      {status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {compact ? null : <span>{status === "copied" ? "Copied" : "Copy"}</span>}
    </button>
    <span className={status === "failed" ? "codex-copy-error" : "visually-hidden"} role="status">{status === "failed" ? "Could not copy" : status === "copied" ? "Copied to clipboard" : ""}</span>
  </span>;
}

// Highlighted code contains nested spans; copy their text, never React objects or markup.
function codeText(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? codeText(child.props.children) : "";
  }).join("");
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement);
  const props = isValidElement<{ children?: ReactNode; className?: string }>(code) ? code.props : undefined;
  const raw = codeText(props?.children).replace(/\n$/, "");
  const language = props?.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] || "Code";
  return <div className="codex-code-block">
    <div className="codex-code-header"><span>{language}</span><CopyButton text={raw} label="Copy code" /></div>
    <pre>{children}</pre>
  </div>;
}

function MarkdownBody({ text }: { text: string }) {
  return <div className="codex-markdown"><Markdown skipHtml rehypePlugins={[rehypeHighlight]} components={{
    pre: CodeBlock,
    // Do not load remote tracking images embedded in model output.
    img: ({ alt }) => <span>{alt || "Image"}</span>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  }}>{text}</Markdown></div>;
}

function safeUrl(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

function ToolCard({ part }: { part: Extract<CodexEventPart, { type: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const running = part.status === "running";
  const visible = running || expanded;
  return <div className="codex-command" data-running={running}>
    <button type="button" className="codex-command-toggle" aria-expanded={visible} onClick={() => setExpanded(!expanded)} disabled={running}>
      <TerminalWindow aria-hidden="true" /><span className="codex-command-title">{running ? "Running" : part.status === "failed" ? "Commands failed" : `Ran ${part.steps.length} ${part.steps.length === 1 ? "command" : "commands"}`}</span>
      {part.durationMs !== undefined ? <span>{Math.round(part.durationMs / 1000)}s</span> : null}
      <CaretDown className="codex-disclosure-icon" data-expanded={visible} aria-hidden="true" />
    </button>
    {visible ? part.steps.map((step, index) => <div className="codex-tool-row" key={index}><span aria-hidden="true">$</span><code>{step.cmd}</code>{step.result ? <span data-ok={step.ok}>{step.result}</span> : null}</div>) : null}
    {visible && part.outputTail ? <pre className="codex-command-output">{running ? part.outputTail.split("\n").slice(-5).join("\n") : part.outputTail}</pre> : null}
  </div>;
}

function StructuredPart({ part }: { part: CodexEventPart }) {
  if (part.type === "text") return <MarkdownBody text={part.markdown} />;
  if (part.type === "tool") return <ToolCard part={part} />;
  if (part.type === "env") return <p className="codex-environment-event">{part.name || part.runBoxId}<span>{part.status}</span></p>;
  if (part.type === "files") return <div className="codex-files"><div className="codex-card-label">{part.files.length} {part.files.length === 1 ? "file" : "files"} changed</div>{part.files.map((file, index) => {
    const href = safeUrl(file.diffUrl);
    const content = <><FileCode aria-hidden="true" /><span className="codex-file-path">{file.path}</span>{file.additions !== undefined ? <span className="codex-additions">+{file.additions}</span> : null}{file.deletions !== undefined ? <span className="codex-deletions">−{file.deletions}</span> : null}</>;
    return href ? <a className="codex-file-row" key={index} href={href} target="_blank" rel="noopener noreferrer">{content}</a> : <div className="codex-file-row" key={index}>{content}</div>;
  })}</div>;
  const href = safeUrl(part.reviewUrl);
  return <div className="codex-handoff"><div className="codex-handoff-label"><ArrowBendUpRight aria-hidden="true" />Handoff <span>to <strong>{part.to}</strong></span></div><h3>{part.title}</h3><p>{part.summary}</p><div><span className="codex-card-label">Next</span><p>{part.next}</p></div>{href ? <a className="button" href={href} target="_blank" rel="noopener noreferrer">Open in Review <ArrowUpRight aria-hidden="true" /></a> : null}</div>;
}

/** Render server snapshots by stable event ID; never synthesize an assistant reply. */
export function CodexConversation({ events, working, emptyLabel, agentName = "Codex", environmentName, emptyContent, onRetry, retryDisabled }: CodexConversationProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const hasMessages = events.some(event => event.kind === "user" || event.kind === "assistant");
  const lastUserIndex = events.reduce((last, event, index) => event.kind === "user" ? index : last, -1);
  const lastAssistantIndex = events.reduce((last, event, index) => event.kind === "assistant" ? index : last, -1);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const follow = () => { if (following.current) node.scrollTop = node.scrollHeight; };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, [events, working]);
  function trackScroll() {
    const node = scroller.current;
    if (!node) return;
    const gap = Number.parseFloat(getComputedStyle(node).rowGap) || 0;
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= gap;
  }
  return <div className="conversation codex-conversation" ref={scroller} onScroll={trackScroll} aria-label="Project conversation" tabIndex={0}>
    {!hasMessages && !working ? emptyContent ?? <div className="main-empty chat-empty" role="status">{emptyLabel ? <p>{emptyLabel}</p> : null}</div> : null}
    {events.map((event, index) => {
      if (!hasMessages && !working && event.kind === "status") return null;
      if (event.kind === "command") {
        const summary = event.text.split("\n").find(line => line.trim()) || "Command output";
        return <details className="codex-command" key={event.id}><summary><TerminalWindow aria-hidden="true" /><span className="codex-command-title">{summary}</span><CaretDown className="codex-disclosure-icon" aria-hidden="true" /></summary><pre className="codex-command-output">{event.text || "No output reported yet."}</pre></details>;
      }
      if (event.kind === "status" || event.kind === "error") return <p key={event.id} className="message-status codex-event-status" data-tone={event.kind === "error" ? "danger" : "muted"} role={event.kind === "error" ? "alert" : "status"}>{event.kind === "error" ? "Error: " : ""}{event.text}</p>;
      const streaming = working && index === lastAssistantIndex && index > lastUserIndex;
      const environment = event.runBoxName || environmentName;
      const copyText = event.parts?.some(part => part.type === "text") ? event.parts.filter(part => part.type === "text").map(part => part.markdown).join("\n\n") : event.text;
      return <article key={event.id} className="message" data-role={event.kind}>
        {event.kind === "user" ? <><span className="visually-hidden">{event.actorName || "Project member"}</span><p className="message-body">{event.text}</p></> : <>
          <div className="codex-agent-header"><span className="codex-agent-avatar"><Robot aria-hidden="true" /></span><span className="codex-agent-name">{event.agentName || agentName}</span>{environment ? <span className="codex-agent-environment">on {environment}</span> : null}</div>
          {event.parts?.length ? event.parts.map((part, partIndex) => <StructuredPart part={part} key={partIndex} />) : event.text ? <MarkdownBody text={event.text} /> : null}
          {streaming ? <span className="codex-streaming-cursor" aria-hidden="true" /> : <div className="codex-message-actions"><CopyButton text={copyText} label="Copy response" compact />{onRetry ? <button type="button" className="codex-action" aria-label="Retry" title="Retry" disabled={working || retryDisabled} onClick={() => onRetry(event.id)}><ArrowClockwise aria-hidden="true" /></button> : null}</div>}
        </>}
      </article>;
    })}
    {working ? <p className="message-status codex-event-status" data-tone="warning" role="status">Responding…</p> : null}
  </div>;
}
