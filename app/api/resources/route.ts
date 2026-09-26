import { resourceAction } from "../../../lib/store";
import { body, failure, sameOrigin } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    return Response.json(await resourceAction(await body(request)));
  } catch (error) {
    return failure(error);
  }
}
