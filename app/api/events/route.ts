import { requireEmployee, employeeState } from "../../../lib/employee";
import { failure } from "../../../lib/http";
import { getState } from "../../../lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireEmployee(request);
  } catch (error) {
    return failure(error);
  }
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let busy = false;
  let snapshot = "";
  const stream = new ReadableStream({
    start(controller) {
      const stop = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", stop, { once: true });
      const tick = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          const employee = await requireEmployee(request);
          const state = employeeState(await getState(), employee);
          if (closed) return;
          const serialized = JSON.stringify(state);
          if (serialized !== snapshot) {
            controller.enqueue(encoder.encode(`data: ${serialized}\n\n`));
            snapshot = serialized;
          } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          stop();
        } finally {
          busy = false;
        }
      };
      void tick();
      interval = setInterval(() => void tick(), 1000);
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
