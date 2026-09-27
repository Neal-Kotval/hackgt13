import { getDatabase } from "../../../../../../lib/auth.mjs";
import { failure, sameOrigin } from "../../../../../../lib/http";
import { requirePlatformAdmin } from "../../../../../../lib/platform-admin";
import { InputError } from "../../../../../../lib/store";
import { migrateRunBoxJobs } from "../../../../../../lib/run-box-jobs.mjs";
import { requestAwsForceClose } from "../../../../../../lib/aws-force-close.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HAC-166: records a force-close request. The AWS worker performs it on its next cycle.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request);
    sameOrigin(request);
    const { id } = await context.params;
    migrateRunBoxJobs(getDatabase());
    const forceClose = requestAwsForceClose(getDatabase(), id, admin.email);
    if (!forceClose) throw new InputError("AWS environment not found", 404);
    return Response.json({ forceClose });
  } catch (error) { return failure(error); }
}
