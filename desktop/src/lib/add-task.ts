export type AddTaskFormInput = {
  projectId: string;
  title: string;
  instructions: string;
  agentId: string;
  environmentId?: string;
};

export type AddTaskPayload = {
  type: "addTask";
  projectId: string;
  title: string;
  owner: string;
  instructions: string;
  environmentId?: string;
};

/**
 * Build POST /api/state addTask body.
 * Sends title, owner, instructions, and optional verified environmentId.
 */
export function buildAddTaskPayload(input: AddTaskFormInput): AddTaskPayload {
  const title = input.title.trim();
  const instructions = input.instructions.trim();
  const owner = input.agentId.trim();
  const environmentId = input.environmentId?.trim() || undefined;
  if (!input.projectId.trim()) {
    throw new Error("Choose a project before creating a task.");
  }
  if (!title) {
    throw new Error("Title is required.");
  }
  if (title.length > 200) {
    throw new Error("Title must be at most 200 characters.");
  }
  if (!instructions) {
    throw new Error("Instructions are required.");
  }
  if (instructions.length > 4000) {
    throw new Error("Instructions must be at most 4000 characters.");
  }
  if (!owner) {
    throw new Error("Choose an agent owner.");
  }
  return {
    type: "addTask",
    projectId: input.projectId.trim(),
    title,
    owner,
    instructions,
    ...(environmentId ? { environmentId } : {}),
  };
}
