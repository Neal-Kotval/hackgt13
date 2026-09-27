import { createBackboardClient } from "../../../../../lib/backboard.mjs";
import { defaultBackboardFile, openBackboardDb } from "../../../../../lib/backboard-memory.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { failure } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

function memories(body: unknown) {
  const rows = Array.isArray(body) ? body : Array.isArray((body as Row | null)?.memories) ? (body as { memories: unknown[] }).memories : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Row;
    const content = typeof item.content === "string" ? item.content.trim() : typeof item.memory === "string" ? item.memory.trim() : "";
    if (!content) return [];
    const id = [item.id, item.memory_id].find((value) => typeof value === "string") as string | undefined;
    const createdAt = [item.created_at, item.createdAt].find((value) => typeof value === "string") as string | undefined;
    return [{ id: id ?? null, content: content.slice(0, 2000), createdAt: createdAt ?? null, score: typeof item.score === "number" ? item.score : null }];
  }).slice(0, 100);
}

/**
 * Read-only view of the project's Backboard memory for project members. Viewing never creates
 * an assistant, and the API key never leaves the server.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    const { id } = await context.params;
    requireMembership(employee, id);
    const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
    if (query.length > 500) throw new InputError("Search must be 500 characters or fewer");
    let client;
    try {
      client = createBackboardClient();
    } catch {
      return Response.json({ available: false });
    }
    if (!client.configured) return Response.json({ available: false });
    const db = openBackboardDb(defaultBackboardFile());
    let assistant: { assistant_id: string } | undefined;
    try {
      assistant = db.prepare("SELECT assistant_id FROM backboard_project WHERE project_id = ?").get(id) as typeof assistant;
    } finally {
      db.close();
    }
    if (!assistant) return Response.json({ available: true, created: false, query, memories: [] });
    try {
      const body = query ? await client.searchMemories(assistant.assistant_id, query) : await client.listMemories(assistant.assistant_id);
      return Response.json({ available: true, created: true, query, memories: memories(body) });
    } catch {
      return Response.json({ error: "Backboard could not be reached. Try again." }, { status: 502 });
    }
  } catch (error) {
    return failure(error);
  }
}
