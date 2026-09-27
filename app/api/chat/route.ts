import {
  ensureProjectChatAgent,
  InputError,
  recordProjectChatTurn,
} from "../../../lib/store";
import { failure, sameOrigin } from "../../../lib/http";
import { requireEmployee, requireMembership } from "../../../lib/employee";
import {
  chatModel,
  parseChatBody,
  parseChatMessages,
  serverModelKeyConfigured,
  streamOpenAIChat,
} from "../../../lib/project-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Employee-authenticated project chat. Model credentials stay on the server.
 * Desktop Electron must not call OpenAI directly.
 */
export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await parseChatBody(request);
    if (typeof input.projectId !== "string" || !input.projectId.trim())
      throw new InputError("projectId is required");
    const projectId = input.projectId.trim();
    requireMembership(employee, projectId);

    const agentId =
      typeof input.agentId === "string" && input.agentId.trim()
        ? input.agentId.trim()
        : undefined;
    const messages = parseChatMessages(input.messages);

    if (!serverModelKeyConfigured()) {
      return Response.json(
        {
          error:
            "Server model credentials are not configured. Set OPENAI_API_KEY in the alto server environment (Doppler or local), then retry.",
        },
        { status: 503 },
      );
    }

    const agent = await ensureProjectChatAgent(projectId, agentId);
    const actor = employee.email || employee.name || employee.id;
    await recordProjectChatTurn(projectId, actor, agent.name);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        };
        try {
          send({
            type: "meta",
            agentId: agent.agentId,
            agentName: agent.name,
            agentCreated: agent.created,
            model: chatModel(),
          });
          await streamOpenAIChat({
            messages,
            signal: request.signal,
            onDelta: (text) => send({ type: "delta", text }),
          });
          send({ type: "done" });
          controller.close();
        } catch (error) {
          const message =
            error instanceof InputError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Chat stream failed";
          send({ type: "error", error: message });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
