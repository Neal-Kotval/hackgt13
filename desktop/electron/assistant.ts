import type { ChatMessage, CredentialStatus } from "../src/lib/types.ts";

export type AssistantDeltaHandler = (chunk: string) => void;

export type StreamAssistantInput = {
  messages: Array<Pick<ChatMessage, "role" | "content">>;
  signal: AbortSignal;
  onDelta: AssistantDeltaHandler;
};

/**
 * Isolated assistant boundary. Swap this for a Codex CLI or AgentCloud runner
 * later without rewriting the chat UI.
 */
export interface AssistantAdapter {
  credentialStatus(): CredentialStatus;
  streamReply(input: StreamAssistantInput): Promise<void>;
}

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

export class OpenAIResponsesAdapter implements AssistantAdapter {
  constructor(
    private readonly getApiKey: () => string | undefined,
    private readonly model: string,
  ) {}

  credentialStatus(): CredentialStatus {
    const key = this.getApiKey()?.trim();
    if (!key) {
      return {
        configured: false,
        source: "none",
        model: this.model,
        message:
          "Set OPENAI_API_KEY in desktop/.env (see desktop/.env.example), then relaunch. The app will not invent replies.",
      };
    }
    return {
      configured: true,
      source: "env",
      model: this.model,
      message: `Using OpenAI model ${this.model} from OPENAI_API_KEY.`,
    };
  }

  async streamReply(input: StreamAssistantInput): Promise<void> {
    const apiKey = this.getApiKey()?.trim();
    if (!apiKey) {
      throw new MissingCredentialsError(
        "OPENAI_API_KEY is not configured. Add it to desktop/.env and relaunch.",
      );
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      }),
      signal: input.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const safe = detail.slice(0, 240).replace(apiKey, "[redacted]");
      throw new Error(
        `OpenAI request failed (${response.status})${safe ? `: ${safe}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("OpenAI response had no body to stream.");
    }

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
        if (chunk) input.onDelta(chunk);
      }
    }
  }
}
