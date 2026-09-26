import { action, getState } from "../../../lib/store";
import { body, failure, sameOrigin } from "../../../lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await getState());
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    return Response.json(await action(await body(request)));
  } catch (error) {
    return failure(error);
  }
}
