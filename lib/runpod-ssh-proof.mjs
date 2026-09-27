import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isIP } from "node:net";

const ACCOUNT = "agentcloud";
const MAX_OUTPUT = 64 * 1024;

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function validateConnection(connection) {
  requireValue(connection && isIP(connection.host || "") === 4, "Runpod direct SSH IPv4 address is required");
  requireValue(Number.isInteger(connection.port) && connection.port > 0 && connection.port <= 65535, "Runpod SSH port is invalid");
  requireValue(typeof connection.keyFile === "string" && connection.keyFile.startsWith("/"), "Runpod SSH private key path is required");
  requireValue(typeof connection.knownHostsFile === "string" && connection.knownHostsFile.startsWith("/"), "A pinned Runpod SSH host key file is required");
  requireValue(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(connection.publicKey || ""), "Runpod SSH public key is invalid");
  return connection;
}

function validateJob(job) {
  requireValue(job?.provider === "runpod" && /^[a-f0-9-]{36}$/.test(job.id || ""), "Runpod job is invalid");
  let url;
  try { url = new URL(job.repo_url); } catch { throw new Error("Approved repository URL is invalid"); }
  requireValue(url.protocol === "https:" && url.hostname && url.pathname !== "/" &&
    !url.username && !url.password && !url.search && !url.hash,
    "Approved repository URL is invalid");
  requireValue(job.repo_revision === null || job.repo_revision === undefined || /^[a-f0-9]{40,64}$/.test(job.repo_revision),
    "Approved repository revision is invalid");
  return url.toString();
}

export function runSsh(connection, account, script, { timeoutMs = 180_000 } = {}) {
  validateConnection(connection);
  requireValue(["root", ACCOUNT].includes(account), "Runpod SSH account is invalid");
  const args = ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${connection.knownHostsFile}`, "-o", "ConnectTimeout=15", "-o", "LogLevel=ERROR",
    "-i", connection.keyFile, "-p", String(connection.port), `${account}@${connection.host}`, "bash -s"];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdin.on("error", () => { /* SSH may exit before consuming the script. */ });
    child.stdout.on("data", (data) => { stdout += data; if (stdout.length > MAX_OUTPUT) { overflow = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", (data) => { stderr += data; if (stderr.length > MAX_OUTPUT) { overflow = true; child.kill("SIGKILL"); } });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("Runpod SSH command timed out"));
      if (overflow) return reject(new Error("Runpod SSH output exceeded limit"));
      if (code !== 0) return reject(new Error(`Runpod SSH command failed (exit ${code})`));
      resolve(stdout);
    });
    child.stdin.end(script);
  });
}

function authorizedKeys(connection) {
  // The operator key plus member device keys chosen at allocation. The desktop connects
  // as this non-root account, so the bootstrap must not replace member keys.
  const keys = Array.isArray(connection.authorizedKeys) && connection.authorizedKeys.length
    ? connection.authorizedKeys : [connection.publicKey];
  requireValue(keys.length <= 256 && keys.includes(connection.publicKey) &&
    keys.every((key) => /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(key)), "Runpod authorized keys are invalid");
  return keys;
}

function bootstrapScript(keys, jobId) {
  const key = Buffer.from(keys.map((item) => `${item}\n`).join("")).toString("base64");
  return `set -euo pipefail
getent passwd ${ACCOUNT} >/dev/null || useradd -m -s /bin/bash ${ACCOUNT}
install -d -m 700 -o ${ACCOUNT} -g ${ACCOUNT} /home/${ACCOUNT}/.ssh
printf '%s' '${key}' | base64 -d > /home/${ACCOUNT}/.ssh/authorized_keys
chmod 600 /home/${ACCOUNT}/.ssh/authorized_keys
chown ${ACCOUNT}:${ACCOUNT} /home/${ACCOUNT}/.ssh/authorized_keys
install -d -m 700 -o ${ACCOUNT} -g ${ACCOUNT} /home/${ACCOUNT}/agentcloud/${jobId}
`;
}

function proofScript(job, repoUrl) {
  const input = Buffer.from(JSON.stringify({ jobId: job.id, repoUrl, revision: job.repo_revision || null })).toString("base64");
  return `set -euo pipefail
python - <<'PY'
import base64, json, os, pathlib, pwd, subprocess, time
import torch
start = time.monotonic()
data = json.loads(base64.b64decode('${input}'))
workspace = pathlib.Path('/home/${ACCOUNT}/agentcloud') / data['jobId']
assert os.geteuid() > 0 and pwd.getpwuid(os.geteuid()).pw_name == '${ACCOUNT}'
assert workspace.is_dir() and workspace.resolve().is_relative_to(pathlib.Path('/home/${ACCOUNT}/agentcloud'))
repo = workspace / 'repo'
if not (repo / '.git').is_dir():
    subprocess.run(['git', 'clone', '--quiet', '--', data['repoUrl'], str(repo)], check=True, timeout=120)
sha = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True, timeout=15).stdout.strip()
assert len(sha) in (40, 64) and all(c in '0123456789abcdef' for c in sha)
if data['revision']:
    assert sha == data['revision'], 'Repository revision changed'
probe = subprocess.run(['nvidia-smi', '-L'], check=True, capture_output=True, text=True, timeout=30).stdout.strip().splitlines()[0]
assert torch.cuda.is_available(), 'CUDA unavailable'
device = torch.cuda.get_device_name(0)
a = torch.tensor([[1., 2.]], device='cpu')
b = torch.tensor([[2.], [1.]], device='cpu')
t = time.monotonic(); cpu = (a @ b).item(); cpu_ms = (time.monotonic()-t)*1000
t = time.monotonic(); gpu = (a.cuda() @ b.cuda()).item(); torch.cuda.synchronize(); gpu_ms = (time.monotonic()-t)*1000
assert abs(cpu - 4) < .001 and abs(gpu - 4) < .001
result = {'uid': os.geteuid(), 'account': '${ACCOUNT}', 'workspace': str(workspace), 'repo_sha': sha,
          'gpu_device': device, 'nvidia_probe': probe, 'workload_value': gpu, 'correct': True,
          'cpu_ms': round(cpu_ms, 3), 'gpu_ms': round(gpu_ms, 3), 'elapsed_ms': int((time.monotonic()-start)*1000)}
print('AGENTCLOUD_EVIDENCE=' + json.dumps(result, separators=(',', ':')))
PY
`;
}

export async function verifyRunpodSsh(job, connection, { run = runSsh } = {}) {
  const repoUrl = validateJob(job);
  validateConnection(connection);
  await run(connection, "root", bootstrapScript(authorizedKeys(connection), job.id));
  const stdout = await run(connection, ACCOUNT, proofScript(job, repoUrl));
  const lines = stdout.split("\n").filter((line) => line.startsWith("AGENTCLOUD_EVIDENCE="));
  requireValue(lines.length === 1, "Runpod GPU proof is missing or ambiguous");
  let proof;
  try { proof = JSON.parse(lines[0].slice("AGENTCLOUD_EVIDENCE=".length)); }
  catch { throw new Error("Runpod GPU proof is invalid"); }
  requireValue(proof.account === ACCOUNT && Number.isInteger(proof.uid) && proof.uid > 0 &&
    proof.workspace === `/home/${ACCOUNT}/agentcloud/${job.id}` && /^[a-f0-9]{40,64}$/.test(proof.repo_sha) &&
    (!job.repo_revision || proof.repo_sha === job.repo_revision) &&
    typeof proof.gpu_device === "string" && proof.gpu_device.length > 0 && proof.gpu_device.length <= 128 &&
    typeof proof.nvidia_probe === "string" && proof.nvidia_probe.length > 0 && proof.nvidia_probe.length <= 256 &&
    proof.correct === true && Math.abs(proof.workload_value - 4) < .001 &&
    Number.isFinite(proof.cpu_ms) && proof.cpu_ms > 0 && Number.isFinite(proof.gpu_ms) && proof.gpu_ms > 0,
    "Runpod GPU proof is incomplete");
  const outputSha256 = createHash("sha256").update(lines[0]).digest("hex");
  return { ...proof, outputSha256, evidenceRef: `ssh:${job.id}:${outputSha256}` };
}
