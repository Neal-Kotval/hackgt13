import { getAuth } from "../../../../lib/auth.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return getAuth().handler(request);
}
export async function POST(request: Request) {
  return getAuth().handler(request);
}
