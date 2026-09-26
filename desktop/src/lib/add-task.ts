export type AddTaskFormInput = {
  projectId: string;
  title: string;
  instructions: string;
  agentId: string;
};

/**
 * Build today's POST /api/state addTask body.
 * Server only persists title + owner (+ optional dependency). Instructions are
 * folded into title (≤200) until a dedicated field exists — never invent
 * environmentId / startAgent fields.
 */
export function buildAddTaskPayload(
  input: AddTaskFormInput,
): { type: "addTask"; projectId: string; title: string; owner: string } {
  const title = input.title.trim();
  const instructions = input.instructions.trim();
  const owner = input.agentId.trim();
  if (!input.projectId.trim()) {
    throw new Error("Choose a project before creating a task.");
  }
  if (!title) {
    throw new Error("Title is required.");
  }
  if (!instructions) {
    throw new Error("Instructions are required.");
  }
  if (!owner) {
    throw new Error("Choose an agent owner.");
  }
  const combined = `${title} — ${instructions}`;
  return {
    type: "addTask",
    projectId: input.projectId.trim(),
    title: combined.slice(0, 200),
    owner,
  };
}
