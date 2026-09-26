import { getDatabase } from "../../../lib/auth.mjs";
import { requireEmployee } from "../../../lib/employee";
import { body, failure, sameOrigin } from "../../../lib/http";
import { InputError } from "../../../lib/store";
import { listSshKeys, migrateSshKeys, registerSshKey } from "../../../lib/ssh-keys.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Device public keys only. Desktop main-process calls carry the session cookie and
// an Origin matching the app (or none); cross-origin browser mutations are denied.
export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    migrateSshKeys(getDatabase());
    return Response.json({ keys: listSshKeys(getDatabase(), employee.id) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    migrateSshKeys(getDatabase());
    let result;
    try {
      result = registerSshKey(getDatabase(), employee.id, { label: input.label, publicKey: input.publicKey });
    } catch (error) {
      if (error instanceof Error && /^(Invalid SSH public key|Only ssh-ed25519 public keys are accepted|Invalid key label)$/.test(error.message))
        throw new InputError(error.message, 400);
      throw error;
    }
    return Response.json({ key: result.key }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return failure(error);
  }
}
