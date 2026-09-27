import { InputError } from "./store";

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

const MAX_MESSAGES = 40;
const MAX_CONTENT = 8000;
const MAX_BODY_BYTES = 262144;

export function chatModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

export function serverModelKeyConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export async function parseChatBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
    throw new InputError("Request too large", 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new InputError("Request too large", 413);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value as Record<string, unknown>;
  } catch {
    throw new InputError("Expected a JSON object");
  }
}

export function parseChatMessages(value: unknown): ChatTurn[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new InputError("messages must be a nonempty array");
  if (value.length > MAX_MESSAGES)
    throw new InputError(`messages is limited to ${MAX_MESSAGES} turns`);
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new InputError(`messages[${index}] must be an object`);
    const record = row as Record<string, unknown>;
    const role = record.role;
    if (role !== "user" && role !== "assistant")
      throw new InputError(`messages[${index}].role must be user or assistant`);
    if (typeof record.content !== "string" || !record.content.trim())
      throw new InputError(`messages[${index}].content must be a nonempty string`);
    if (record.content.length > MAX_CONTENT)
      throw new InputError(
        `messages[${index}].content exceeds ${MAX_CONTENT} characters`,
      );
    return { role, content: record.content.trim() };
  });
}

/**
 * Stream OpenAI chat completions and forward text deltas.
 * Never logs or returns the API key.
 */
export async function streamOpenAIChat(options: {
  messages: ChatTurn[];
  signal: AbortSignal;
  onDelta: (chunk: string) => void;
}): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new InputError(
      "Server model credentials are not configured. Set OPENAI_API_KEY in the AgentCloud server environment (Doppler or local), then retry.",
      503,
    );
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: chatModel(),
      stream: true,
      messages: options.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const safe = detail.slice(0, 240).replaceAll(apiKey, "[redacted]");
    throw new InputError(
      `Model request failed (${response.status})${safe ? `: ${safe}` : ""}`,
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }

  if (!response.body) throw new InputError("Model response had no body", 502);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let parsed: {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      try {
        parsed = JSON.parse(data) as typeof parsed;
      } catch {
        continue;
      }
      const chunk = parsed.choices?.[0]?.delta?.content;
      if (chunk) options.onDelta(chunk);
    }
  }
}
