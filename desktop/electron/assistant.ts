import type { ChatMessage, CredentialStatus } from "../src/lib/types.ts";
import type { LoopbackApiClient } from "./api-client.ts";

export type AssistantDeltaHandler = (chunk: string) => void;

export type StreamAssistantInput = {
  projectId: string;
  agentId?: string;
  messages: Array<Pick<ChatMessage, "role" | "content">>;
  signal: AbortSignal;
  onDelta: AssistantDeltaHandler;
};

/**
 * Isolated assistant boundary. Desktop talks to the AgentCloud project agent
 * API; model credentials stay on the server.
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

export class MissingProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingProjectError";
  }
}

/**
 * Routes chat through POST /api/chat with the employee session.
 * Never reads OPENAI_API_KEY in the Electron process.
 */
export class ProjectAgentChatAdapter implements AssistantAdapter {
  constructor(
    private readonly api: LoopbackApiClient,
    private readonly modelHint = "server-configured",
  ) {}

  credentialStatus(): CredentialStatus {
    return {
      configured: true,
      source: "agentcloud",
      model: this.modelHint,
      message:
        "Replies go through the selected project's AgentCloud agent. Model credentials stay on the server.",
    };
  }

  async streamReply(input: StreamAssistantInput): Promise<void> {
    const projectId = input.projectId?.trim();
    if (!projectId) {
      throw new MissingProjectError(
        "Select a project before chatting. Desktop chat talks to that project's agent, not a local OpenAI key.",
      );
    }

    await this.api.streamProjectChat({
      projectId,
      agentId: input.agentId,
      messages: input.messages,
      signal: input.signal,
      onDelta: input.onDelta,
    });
  }
}
