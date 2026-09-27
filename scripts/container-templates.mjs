#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDatabase } from "../lib/auth.mjs";
import { getContainerTemplate, inspectContainerImage, listContainerTemplates,
  loadContainerArchive, registerContainerTemplate, retainContainerImage } from "../lib/container-templates.mjs";
import { createDockerSandboxProvider, sandboxInstallId } from "../lib/docker-sandbox-provider.mjs";
import { generateSandboxKeypair, runSandboxSsh, verifyDockerSandboxSsh } from "../lib/docker-sandbox-worker.mjs";
import { knownHostsLine } from "../lib/run-box-ssh.mjs";

export async function testContainerTemplate(imageId, { createProvider = createDockerSandboxProvider,
  generateKeypair = generateSandboxKeypair, run = runSandboxSsh } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-template-"));
  chmodSync(directory, 0o700);
  const jobId = randomUUID();
  const provider = createProvider({ image: imageId, installId: sandboxInstallId(directory) });
  try {
    const host = await generateKeypair(directory, "host_ed25519");
    const member = await generateKeypair(directory, "member_ed25519");
    const verifier = await generateKeypair(directory, "verify_ed25519");
    const outsider = await generateKeypair(directory, "outsider_ed25519");
    await provider.create({ jobId, hostPrivateKeyB64: Buffer.from(host.privateKey).toString("base64"),
      authorizedKeys: [member.publicKey, verifier.publicKey] });
    const port = await provider.sshPort(jobId);
    const knownHostsFile = path.join(directory, "known_hosts");
    writeFileSync(knownHostsFile, `${knownHostsLine({ host: "127.0.0.1", port, hostPublicKey: host.publicKey })}\n`, { mode: 0o600 });
    const connection = { host: "127.0.0.1", port, username: "agentcloud", keyFile: member.keyFile, knownHostsFile };
    await verifyDockerSandboxSsh({ id: jobId, repo_url: null },
      { ...connection, keyFile: verifier.keyFile, verificationPublicKey: verifier.publicKey }, { run });
    let result;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      result = await run(connection, `set -euo pipefail
test "$(id -un)" = agentcloud
test "$(id -u)" -ne 0
test -w "$HOME/workspace"
node --version
npm --version
codex --version
git --version
`);
      if (result.code === 0) break;
      if (result.code !== 255 || /Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(result.stderr)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (result?.code !== 0) throw new Error(`Template guest verification failed (exit ${result?.code ?? "unknown"})`);
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 4 || !/^v\d+\./.test(lines[0]) || !/^\d+\./.test(lines[1]) ||
        !/^codex-cli /.test(lines[2]) || !/^git version /.test(lines[3]))
      throw new Error("Template guest tool versions were incomplete");
    const outsiderProbe = await run({ ...connection, keyFile: outsider.keyFile }, "true\n");
    if (outsiderProbe.code !== 255 || !/Permission denied/i.test(outsiderProbe.stderr))
      throw new Error("Template accepted an unregistered SSH key");
    const rootProbe = await run({ ...connection, username: "root" }, "true\n");
    if (rootProbe.code !== 255 || !/Permission denied/i.test(rootProbe.stderr))
      throw new Error("Template allowed root SSH login");
    return { imageId, account: "agentcloud", workspace: "/home/agentcloud/workspace",
      node: lines[0], npm: lines[1], codex: lines[2], git: lines[3] };
  } finally {
    try { await provider.remove(jobId); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1] || Object.hasOwn(result, args[i].slice(2)))
      throw new Error("Expected unique --key value options");
    result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const db = getDatabase();
  if (action === "list" && !args.length) {
    console.log(JSON.stringify(listContainerTemplates(db)));
    return;
  }
  const input = options(args);
  if (action === "import" && input.id && input.label && input.image &&
      Object.keys(input).every((key) => ["id", "label", "image", "archive"].includes(key))) {
    if (input.archive) {
      const loaded = await loadContainerArchive(path.resolve(input.archive));
      if (!loaded.has(input.image)) throw new Error("Selected image reference was not loaded from archive");
    }
    const imageId = await inspectContainerImage(input.image);
    const existing = getContainerTemplate(db, input.id);
    if (existing && (existing.image_id !== imageId || existing.image_ref !== input.image ||
        existing.label !== input.label || existing.source !== (input.archive ? "archive" : "registry")))
      throw new Error("Template ID is already registered with different content");
    const evidence = await testContainerTemplate(imageId);
    await retainContainerImage(input.id, imageId);
    const template = registerContainerTemplate(db, { id: input.id, label: input.label,
      imageRef: input.image, imageId, source: input.archive ? "archive" : "registry" });
    console.log(JSON.stringify({ template, evidence }));
    return;
  }
  if (action === "test" && input.id && Object.keys(input).length === 1) {
    const template = getContainerTemplate(db, input.id);
    if (!template) throw new Error("Template not found");
    console.log(JSON.stringify(await testContainerTemplate(template.image_id)));
    return;
  }
  throw new Error("Usage: node scripts/container-templates.mjs list | import --id ID --label LABEL --image REF [--archive FILE] | test --id ID");
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
