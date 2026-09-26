import { createAwsCli } from "./aws-gpu-provider.mjs";

const ACCOUNT = "662660921850";
const SECRET = "agentcloud/runpod/expiry-guard-api-key";

export async function loadRunpodApiKey({ aws = createAwsCli() } = {}) {
  const identity = await aws("sts", "get-caller-identity");
  if (identity.Account !== ACCOUNT ||
      !new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/agentcloud-auth-staging/[^/]+$`).test(identity.Arn || ""))
    throw new Error("Runpod worker requires the private staging instance role");
  const secret = await aws("secretsmanager", "get-secret-value", "--region", "us-east-1", "--secret-id", SECRET);
  if (typeof secret.SecretString !== "string" || !secret.SecretString.trim() ||
      secret.SecretString.length > 2048 || /[\r\n]/.test(secret.SecretString))
    throw new Error("Runpod API key is unavailable in Secrets Manager");
  return secret.SecretString;
}
