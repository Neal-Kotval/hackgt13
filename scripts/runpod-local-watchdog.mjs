#!/usr/bin/env node

// Local-only cleanup guard for supervised Runpod tests from a developer machine.
// Runs as its own process, separate from the worker: it terminates every managed
// (agentcloud-*) Pod a fixed number of minutes after first seeing it, and writes a
// heartbeat the worker's local mode requires before it will create a Pod.
// Staging uses the independent AWS guard (HAC-84) instead; this does not replace it.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRunpodProvider } from "../lib/runpod-provider.mjs";

export function watchdogFile() {
  return process.env.AGENTCLOUD_RUNPOD_WATCHDOG_FILE ||
    path.resolve(process.env.AGENTCLOUD_DATA_DIR || ".agentcloud", "runpod-local-watchdog.json");
}

export function localWatchdogReady(file = watchdogFile(), now = Date.now()) {
  try {
    const beat = JSON.parse(readFileSync(file, "utf8"));
    return Number.isFinite(Date.parse(beat.at)) && now - Date.parse(beat.at) < 30_000 && beat.maxMinutes > 0;
  } catch { return false; }
}

async function main() {
  const maxMinutes = Number(process.env.AGENTCLOUD_RUNPOD_LOCAL_MAX_MINUTES || 15);
  if (!Number.isFinite(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) throw new Error("Invalid watchdog limit");
  const provider = createRunpodProvider({ apiKey: process.env.RUNPOD_API_KEY });
  const file = watchdogFile();
  let firstSeen = {};
  try { firstSeen = JSON.parse(readFileSync(file, "utf8")).firstSeen || {}; } catch { /* Fresh start. */ }
  console.log(`Runpod local watchdog: terminating managed Pods ${maxMinutes} min after first seen`);
  while (true) {
    try {
      const pods = (await provider.listPods()).filter((pod) => pod.name.startsWith("agentcloud-"));
      const now = Date.now();
      for (const pod of pods) {
        firstSeen[pod.id] ??= now;
        const age = (now - firstSeen[pod.id]) / 60_000;
        if (age >= maxMinutes) {
          await provider.terminatePod(pod.id);
          console.log(`Terminated ${pod.name} after ${age.toFixed(1)} min`);
        }
      }
      for (const id of Object.keys(firstSeen)) if (!pods.some((pod) => pod.id === id)) delete firstSeen[id];
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), maxMinutes, firstSeen }), { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      // No heartbeat on failure: the worker then refuses new allocations.
      console.error(`Watchdog cycle failed: ${String(error.message).slice(0, 200)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
