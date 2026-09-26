import { useEffect, useRef } from "react";
import type { ChatMessage } from "../lib/types";

type ConversationProps = {
  messages: ChatMessage[];
  emptyLabel: string;
};

function statusLabel(message: ChatMessage): {
  text: string;
  tone: "warning" | "danger" | "success" | "muted";
} | null {
  if (message.status === "streaming") {
    return { text: "Responding…", tone: "warning" };
  }
  if (message.status === "cancelled") {
    return { text: "Stopped", tone: "warning" };
  }
  if (message.status === "failed") {
    return {
      text: message.error || "Response failed.",
      tone: "danger",
    };
  }
  return null;
}

export function Conversation({ messages, emptyLabel }: ConversationProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      stickToBottomRef.current = distance < 48;
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || !stickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  return (
    <div className="conversation" ref={scrollerRef} aria-live="polite">
      {messages.length === 0 ? (
        <div className="main-empty chat-empty" role="status">
          <h2 className="chat-empty-title">What can I help with?</h2>
          {emptyLabel ? <p>{emptyLabel}</p> : null}
        </div>
      ) : null}
      {messages.map((message) => {
        const status = statusLabel(message);
        return (
          <article
            key={message.id}
            className="message"
            data-role={message.role}
          >
            <div
              className={message.role === "user" ? "visually-hidden" : "message-role"}
            >
              {message.role === "user" ? "You" : "Assistant"}
            </div>
            {message.content ? (
              <p className="message-body">{message.content}</p>
            ) : null}
            {status ? (
              <div className="message-status" data-tone={status.tone}>
                {status.text}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
