import { createHash } from "node:crypto";
import path from "node:path";

// Several AgentCloud installs (the shared staging worker, a developer's local worker,
// a smoke test) can share one AWS account. Each tags the instances it launches with its
// install ID and only reconciles its own. The expiry Lambda and the budget guard remain
// the account-wide safety net for every tagged instance.
export const INSTALL_TAG = "AgentCloudInstall";

export function awsInstallId(env = process.env) {
  if (/^[a-f0-9]{16}$/.test(env.AGENTCLOUD_INSTALL_ID || "")) return env.AGENTCLOUD_INSTALL_ID;
  return createHash("sha256").update(path.resolve(env.AGENTCLOUD_DATA_DIR || ".agentcloud")).digest("hex").slice(0, 16);
}

// Untagged instances predate install scoping and keep the previous behavior.
export function ownedByInstall(instanceTags, installId) {
  const owner = instanceTags?.[INSTALL_TAG];
  return !owner || !installId || owner === installId;
}
