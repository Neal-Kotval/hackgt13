#!/usr/bin/env node

import { pinRunpodHostKey } from "../lib/runpod-host-key.mjs";

if (process.argv.length !== 5) {
  console.error("Usage: node scripts/runpod-pin-host-key.mjs <Pod IPv4> <mapped SSH port> <trusted SHA256 fingerprint>");
  process.exit(2);
}

try {
  const result = pinRunpodHostKey({ host: process.argv[2], port: Number(process.argv[3]),
    expectedFingerprint: process.argv[4] });
  console.log(`${result.added ? "Pinned" : "Already pinned"} ${result.label} ${result.fingerprint}`);
} catch (error) {
  console.error(`Runpod SSH host key pin failed: ${String(error.message).slice(0, 180)}`);
  process.exitCode = 1;
}
