import { getDatabase } from "../../../../lib/auth.mjs";
import { failure } from "../../../../lib/http";
import { requirePlatformAdmin } from "../../../../lib/platform-admin";
import { getState } from "../../../../lib/store";
import { migrateRunBoxJobs } from "../../../../lib/run-box-jobs.mjs";
import { listActiveAwsEnvironments } from "../../../../lib/aws-force-close.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HAC-166: every non-stopped AWS environment across the install, for the platform admin.
export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request);
    migrateRunBoxJobs(getDatabase());
    const projects = new Map((await getState()).projects.map((project) => [project.id, project.name]));
    const environments = listActiveAwsEnvironments(getDatabase()).map((environment: { projectId: string }) => ({
      ...environment, projectName: projects.get(environment.projectId) ?? null,
    }));
    return Response.json({ environments });
  } catch (error) { return failure(error); }
}
