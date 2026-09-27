import { getDatabase } from "../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../lib/http";
import { InputError } from "../../../../lib/store";
import { migrateRunBoxJobs } from "../../../../lib/run-box-jobs.mjs";
import { getEnvironmentSettings, setEnvironmentSettings } from "../../../../lib/environment-settings.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const db = getDatabase();
    migrateRunBoxJobs(db);
    return Response.json(getEnvironmentSettings(db, employee.id));
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    if (Object.keys(input).some((key) => key !== "maxActiveEnvironments"))
      throw new InputError("Only maxActiveEnvironments can be changed");
    const db = getDatabase();
    migrateRunBoxJobs(db);
    return Response.json(setEnvironmentSettings(db, employee.id, input.maxActiveEnvironments));
  } catch (error) { return failure(error); }
}
