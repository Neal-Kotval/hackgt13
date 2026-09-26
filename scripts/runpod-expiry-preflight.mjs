import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REGION = "us-east-1";
const ACCOUNT = "662660921850";
const NAME = "agentcloud-runpod-expiry";
const PARAMETER = "/agentcloud/runpod-expiry-guard/last-success";
const MAX_AGE_MS = 10 * 60 * 1000;

async function awsJson(args) {
  const { stdout } = await execFileAsync("aws", [...args, "--region", REGION, "--output", "json"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function inspectRunpodExpiryGuard({ call = awsJson, now = Date.now() } = {}) {
  try {
    const identity = await call(["sts", "get-caller-identity"]);
    if (identity.Account !== ACCOUNT) return { ready: false, reason: "wrong AWS account" };

    const [lambda, rule, targets, parameter] = await Promise.all([
      call(["lambda", "get-function-configuration", "--function-name", NAME]),
      call(["events", "describe-rule", "--name", NAME]),
      call(["events", "list-targets-by-rule", "--rule", NAME]),
      call(["ssm", "get-parameter", "--name", PARAMETER]),
    ]);
    if (lambda.State !== "Active" || lambda.LastUpdateStatus !== "Successful")
      return { ready: false, reason: "expiry function inactive" };
    if (rule.State !== "ENABLED" || rule.ScheduleExpression !== "rate(5 minutes)")
      return { ready: false, reason: "expiry schedule disabled" };
    if (!Array.isArray(targets.Targets) || !targets.Targets.some((target) => target.Arn === lambda.FunctionArn))
      return { ready: false, reason: "expiry schedule target missing" };
    const lastSuccess = Date.parse(parameter.Parameter?.Value);
    if (!Number.isFinite(lastSuccess) || lastSuccess > now + 60_000 || now - lastSuccess > MAX_AGE_MS)
      return { ready: false, reason: "expiry scan stale" };
    return { ready: true, lastSuccessAt: new Date(lastSuccess).toISOString() };
  } catch {
    return { ready: false, reason: "expiry guard status unavailable" };
  }
}

export async function checkRunpodExpiryGuard(options) {
  return (await inspectRunpodExpiryGuard(options)).ready;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await inspectRunpodExpiryGuard();
  process.stdout.write(`Runpod expiry guard: ${result.ready ? "ready" : result.reason}\n`);
  if (!result.ready) process.exitCode = 1;
}
