import { agentAction, InputError } from "../../../lib/store";
import { body, failure } from "../../../lib/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer "))
      throw new InputError("Bearer token required", 401);
    return Response.json(
      await agentAction(authorization.slice(7), await body(request)),
    );
  } catch (error) {
    return failure(error);
  }
}
