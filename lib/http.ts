import { InputError } from "./store";
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const requestHost = host || new URL(request.url).host;
  const publicOrigin = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : null;
  const requestProtocol = publicOrigin?.host === requestHost
    ? publicOrigin.protocol.replace(":", "")
    : request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  let parsedOrigin: URL | null = null;
  try {
    if (origin) parsedOrigin = new URL(origin);
  } catch {
    throw new InputError("Cross-origin mutations are denied", 403);
  }
  if (parsedOrigin && (parsedOrigin.host !== requestHost || parsedOrigin.protocol !== `${requestProtocol}:`))
    throw new InputError("Cross-origin mutations are denied", 403);
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > 32768)
    throw new InputError("Request too large", 413);
  const text = await request.text();
  if (text.length > 32768) throw new InputError("Request too large", 413);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw new InputError("Expected a JSON object");
  }
}
export function failure(error: unknown) {
  if (error instanceof InputError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error(error);
  return Response.json(
    { error: "Internal persistence error" },
    { status: 500 },
  );
}
