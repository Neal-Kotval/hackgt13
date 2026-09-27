import { sameOrigin } from "../../../../../../../lib/http";
import { InputError } from "../../../../../../../lib/store";
import { authorizeSession, terminalFailure } from "../../../../../../../lib/web-terminal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

// Server-sent events for one terminal session. Output arrives as base64 `data:` lines
// (default event), `event: close` carries { reason, message }, and comment heartbeats
// keep proxies such as CloudFront (30 s origin read timeout) from closing an idle stream.
// Dropping this stream closes the SSH session.
export async function GET(request: Request, context: { params: Promise<{ id: string; sessionId: string }> }) {
  let authorized;
  const { id, sessionId } = await context.params;
  try {
    // EventSource sends no Origin on same-origin GETs; reject any cross-site attach.
    sameOrigin(request);
    const site = request.headers.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) throw new InputError("Cross-origin terminal streams are denied", 403);
    authorized = await authorizeSession(request, id, sessionId);
  } catch (error) {
    return terminalFailure(error);
  }
  const { employee, service } = authorized;
  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* Already closed. */ }
        const release = detach;
        detach = null;
        release?.();
      };
      const send = (text: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { end(); }
      };
      try {
        detach = service.attach(sessionId, employee.id, id, (event: { type: string; data?: Buffer; reason?: string; message?: string }) => {
          if (event.type === "data" && event.data) send(`data: ${event.data.toString("base64")}\n\n`);
          else if (event.type === "close") {
            send(`event: close\ndata: ${JSON.stringify({ reason: event.reason, message: event.message })}\n\n`);
            detach = null;
            end();
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Terminal session not found";
        send(`event: close\ndata: ${JSON.stringify({ reason: "attach_failed", message })}\n\n`);
        end();
        return;
      }
      send(": attached\n\n");
      heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      request.signal.addEventListener("abort", end, { once: true });
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      const release = detach;
      detach = null;
      release?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
