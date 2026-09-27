import { useLayoutEffect, useRef } from "react";
import "./CodexConversation.css";

export type CodexEvent = {
  id: string;
  kind: "user" | "assistant" | "command" | "status" | "error";
  text: string;
  actorName?: string;
  createdAt?: string;
  updatedAt: string;
};

type CodexConversationProps = {
  events: CodexEvent[];
  working: boolean;
  emptyLabel?: string;
};

/** Render server snapshots by stable event ID; never synthesize an assistant reply. */
export function CodexConversation({ events, working, emptyLabel }: CodexConversationProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const follow = () => {
      if (following.current) node.scrollTop = node.scrollHeight;
    };
    follow();
    // Follow late font/layout changes and disclosure expansion only while at the end.
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

  return (
    <div className="conversation codex-conversation" ref={scroller} onScroll={trackScroll} aria-label="Codex conversation" tabIndex={0}>
      {events.length === 0 && !working ? (
        <div className="main-empty chat-empty" role="status">
          <h2 className="chat-empty-title">What can I help with?</h2>
          {emptyLabel ? <p>{emptyLabel}</p> : null}
        </div>
      ) : null}
      {events.map((event) => {
        if (event.kind === "command") {
          const summary = event.text.split("\n").find(line => line.trim()) || "Command output";
          return (
            <details className="codex-command" key={event.id}>
              <summary><span className="codex-command-label">Local Docker</span><span className="codex-command-title">{summary}</span></summary>
              <pre className="codex-command-output">{event.text || "No output reported yet."}</pre>
            </details>
          );
        }
        if (event.kind === "status" || event.kind === "error") {
          return <p key={event.id} className="message-status codex-event-status" data-tone={event.kind === "error" ? "danger" : "muted"} role={event.kind === "error" ? "alert" : "status"}>{event.kind === "error" ? "Error: " : ""}{event.text}</p>;
        }
        return (
          <article key={event.id} className="message" data-role={event.kind}>
            <div className={event.kind === "user" ? "visually-hidden" : "message-role"}>{event.kind === "user" ? event.actorName || "Project member" : "Codex"}</div>
            {event.text ? <p className="message-body">{event.text}</p> : null}
          </article>
        );
      })}
      {working ? <p className="message-status codex-event-status" role="status">Codex is working…</p> : null}
    </div>
  );
}
