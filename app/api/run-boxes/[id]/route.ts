import { getDatabase } from "../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../lib/http";
import { InputError } from "../../../../lib/store";
import { forceStopRunBoxJob, requestRunBoxStop } from "../../../../lib/run-box-jobs.mjs";
import { markRunBoxDeleted, updateRunBoxMetadata } from "../../../../lib/run-box-metadata.mjs";
import { resolveJobAccess, runBoxVisibleTo } from "../../../../lib/run-box-access.mjs";
import { GET as listRunBoxes } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One environment (docs/environment-model-contract.md).
// GET    ?projectId=                         -> { job }
// PATCH  { projectId, name?, visibility? }   -> { job }   creator, or a project owner for public jobs
// DELETE ?projectId=                         -> { ok }    same permission; stops first, then hides
// Private jobs answer 404 to everyone but their creator; deleted jobs answer 404 to reads.

type Context = { params: Promise<{ id: string }> };

function projectIdFrom(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new InputError("Invalid project ID");
  return value;
}

// The single-job JSON is the list entry, so both carry the same fields (SSH, agent,
// memory, and anything later added to the list). The list applies the same policy.
async function jobView(request: Request, projectId: string, id: string) {
  const url = new URL(`/api/run-boxes?${new URLSearchParams({ projectId })}`, request.url);
  const listed = await listRunBoxes(new Request(url, { headers: request.headers }));
  if (!listed.ok) return listed;
  const job = ((await listed.json()) as { jobs: { id: string }[] }).jobs.find((item) => item.id === id);
  if (!job) throw new InputError("Run-box job not found", 404);
  return Response.json({ job }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request, context: Context) {
  try {
    const employee = await requireEmployee(request);
    const projectId = projectIdFrom(new URL(request.url).searchParams.get("projectId"));
    const { id } = await context.params;
    resolveJobAccess(getDatabase(), employee, projectId, id);
    return await jobView(request, projectId, id);
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    for (const key of Object.keys(input))
      if (!["projectId", "name", "visibility"].includes(key)) throw new InputError(`Unsupported field: ${key}`);
    const projectId = projectIdFrom(input.projectId);
    if (input.name === undefined && input.visibility === undefined) throw new InputError("Nothing to change");
    const { id } = await context.params;
    const db = getDatabase();
    const { permissions } = resolveJobAccess(db, employee, projectId, id);
    if (!permissions.manage)
      throw new InputError("Only the environment's creator or a project owner can change it", 403);
    const changes: { name?: unknown; visibility?: unknown } = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.visibility !== undefined) changes.visibility = input.visibility;
    try {
      updateRunBoxMetadata(db, id, employee.id, changes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "Environment was deleted") throw new InputError("Run-box job not found", 404);
      if (/^Invalid environment (name|visibility)$/.test(message))
        throw new InputError(message === "Invalid environment name"
          ? "Name must be 1 to 60 characters with no control characters" : "Visibility must be private or public");
      throw error;
    }
    // A job made private by a project owner who did not create it is no longer theirs to see.
    if (!runBoxVisibleTo(db, employee, id)) return Response.json({ job: null });
    return await jobView(request, projectId, id);
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const projectId = projectIdFrom(new URL(request.url).searchParams.get("projectId"));
    const { id } = await context.params;
    const db = getDatabase();
    const { job, meta, permissions } = resolveJobAccess(db, employee, projectId, id, { includeDeleted: true });
    if (!permissions.manage)
      throw new InputError("Only the environment's creator or a project owner can delete it", 403);
    if (meta.deletedAt) return Response.json({ ok: true });
    // Delete never skips termination: it takes the same stop / force-stop paths as the
    // Stop controls, so the worker still terminates the resource and records release
    // evidence. The job row and its transitions stay for audit.
    if (job.state === "stopping") forceStopRunBoxJob(db, id, employee.id);
    else if (job.state !== "stopped") requestRunBoxStop(db, id, employee.id);
    markRunBoxDeleted(db, id, employee.id);
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
