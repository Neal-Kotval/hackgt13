import assert from "node:assert/strict";
import test from "node:test";
import { loadRunpodApiKey } from "../lib/runpod-secret.mjs";

const identity = { Account: "662660921850",
  Arn: "arn:aws:sts::662660921850:assumed-role/agentcloud-auth-staging/i-123" };

test("Runpod key loader accepts only staging role and never returns metadata", async () => {
  const calls = [];
  const key = await loadRunpodApiKey({ aws: async (service, operation, ...args) => {
    calls.push([service, operation, ...args]);
    return service === "sts" ? identity : { SecretString: "test-key", ARN: "private-arn" };
  } });
  assert.equal(key, "test-key");
  assert.deepEqual(calls[1], ["secretsmanager", "get-secret-value", "--region", "us-east-1",
    "--secret-id", "agentcloud/runpod/expiry-guard-api-key"]);
  await assert.rejects(loadRunpodApiKey({ aws: async () => ({ Account: identity.Account,
    Arn: `arn:aws:iam::${identity.Account}:root` }) }), /requires the private staging instance role/);
});

test("Runpod key loader rejects missing or malformed secret values", async () => {
  const aws = async (service) => service === "sts" ? identity : { SecretString: "key\nprivate" };
  await assert.rejects(loadRunpodApiKey({ aws }), /unavailable in Secrets Manager/);
});
