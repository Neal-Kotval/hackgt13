/**
 * A small Markdown subset for Codex replies. It produces a plain data tree that
 * React renders as elements, so model output never becomes raw HTML.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string | null; children: Inline[] };

export type Block =
  | { type: "code"; language: string | null; text: string }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" }
  | { type: "paragraph"; children: Inline[] };

/** Only absolute http(s) and mailto links are kept; everything else renders as text. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ type: "text", text: buffer }); buffer = ""; } };
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) { flush(); out.push({ type: "code", text: code[2].replace(/^ (.*) $/, "$1") }); index += code[0].length; continue; }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) { flush(); out.push({ type: "link", href: safeHref(link[2]), children: parseInline(link[1]) }); index += link[0].length; continue; }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) { flush(); out.push({ type: "strong", children: parseInline(strong[2]) }); index += strong[0].length; continue; }
    const em = /^(\*|_)(?=\S)([^*_\n]*?\S)\1(?![A-Za-z0-9])/.exec(rest);
    if (em && (em[1] === "*" || !/[A-Za-z0-9]/.test(source[index - 1] ?? ""))) { flush(); out.push({ type: "em", children: parseInline(em[2]) }); index += em[0].length; continue; }
    buffer += source[index];
    index += 1;
  }
  flush();
  return out;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      // An unterminated fence (a reply still streaming) runs to the end.
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) { body.push(lines[index]); index += 1; }
      index += 1;
      blocks.push({ type: "code", language: fence[2] || null, text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) }); index += 1; continue; }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); index += 1; continue; }
    const list = BULLET.exec(line) ? BULLET : ORDERED.exec(line) ? ORDERED : null;
    if (list) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim()) {
        const match = list.exec(lines[index]);
        if (match) items.push(match[1]);
        else if (items.length && /^\s+\S/.test(lines[index])) items[items.length - 1] += `\n${lines[index].trim()}`;
        else break;
        index += 1;
      }
      blocks.push({ type: "list", ordered: list === ORDERED, items: items.map(parseInline) });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) { quoted.push(QUOTE.exec(lines[index])![1]); index += 1; }
      blocks.push({ type: "quote", children: parseInline(quoted.join("\n")) });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !FENCE.test(lines[index]) && !HEADING.test(lines[index]) && !BULLET.test(lines[index]) && !ORDERED.test(lines[index]) && !QUOTE.test(lines[index]) && !RULE.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}
