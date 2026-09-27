import { requireEmployee } from "./employee";
import { InputError } from "./store";

// The single platform operator named by AGENTCLOUD_PLATFORM_ADMIN_EMAIL (verified session).
export async function requirePlatformAdmin(request: Request) {
  const employee = await requireEmployee(request);
  const configured = process.env.AGENTCLOUD_PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  if (!configured || employee.email.toLowerCase() !== configured)
    throw new InputError("Platform operator access required", 403);
  return employee;
}
