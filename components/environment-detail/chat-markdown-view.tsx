import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "./chat-markdown";

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === "text") return <Fragment key={index}>{node.text}</Fragment>;
    if (node.type === "code") return <code key={index}>{node.text}</code>;
    if (node.type === "strong") return <strong key={index}>{renderInline(node.children)}</strong>;
    if (node.type === "em") return <em key={index}>{renderInline(node.children)}</em>;
    return node.href
      ? <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow">{renderInline(node.children)}</a>
      : <Fragment key={index}>{renderInline(node.children)}</Fragment>;
  });
}

/** Renders Codex Markdown as React elements only (no HTML injection, no remote images). */
export function ChatMarkdown({ text }: { text: string }) {
  return <div className="env-chat-markdown">
    {parseMarkdown(text).map((block, index) => {
      if (block.type === "code") return <div className="env-chat-code" key={index}>
        {block.language ? <span className="env-chat-code-language">{block.language}</span> : null}
        <pre tabIndex={0}><code>{block.text}</code></pre>
      </div>;
      if (block.type === "heading") {
        const Tag = block.level <= 2 ? "h4" : block.level <= 4 ? "h5" : "h6";
        return <Tag key={index}>{renderInline(block.children)}</Tag>;
      }
      if (block.type === "list") {
        const Tag = block.ordered ? "ol" : "ul";
        return <Tag key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</Tag>;
      }
      if (block.type === "quote") return <blockquote key={index}>{renderInline(block.children)}</blockquote>;
      if (block.type === "rule") return <hr key={index} />;
      return <p key={index}>{renderInline(block.children)}</p>;
    })}
  </div>;
}
