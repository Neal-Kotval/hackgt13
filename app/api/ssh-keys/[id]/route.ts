import { getDatabase } from "../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../lib/employee";
import { failure, sameOrigin } from "../../../../lib/http";
import { InputError } from "../../../../lib/store";
import { migrateSshKeys, revokeSshKey } from "../../../../lib/ssh-keys.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const { id } = await context.params;
    if (typeof id !== "string" || !id || id.length > 64) throw new InputError("SSH key not found", 404);
    migrateSshKeys(getDatabase());
    // Only the owner's active key can be revoked; another user's key reads as absent.
    if (!revokeSshKey(getDatabase(), employee.id, id)) throw new InputError("SSH key not found", 404);
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
