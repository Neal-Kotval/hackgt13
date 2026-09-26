import { requireEmployee } from "../../../lib/employee";
import { failure } from "../../../lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    return Response.json(await requireEmployee(request));
  } catch (error) {
    return failure(error);
  }
}
