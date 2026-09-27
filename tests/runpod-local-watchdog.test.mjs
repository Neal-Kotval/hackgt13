import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRunpodAccess, localWatchdogReady } from "../scripts/runpod-local-watchdog.mjs";

test("local Runpod mode allocates only while the separate watchdog heartbeat is fresh", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "agentcloud-watchdog-")), "beat.json");
  assert.equal(localWatchdogReady(file), false);
  const now = Date.parse("2026-09-26T21:00:00Z");
  writeFileSync(file, JSON.stringify({ at: new Date(now - 5_000).toISOString(), maxMinutes: 5, firstSeen: {} }));
  assert.equal(localWatchdogReady(file, now), true);
  assert.equal(localWatchdogReady(file, now + 40_000), false);
  writeFileSync(file, "not json");
  assert.equal(localWatchdogReady(file, now), false);
});

test("the watchdog access check only lists Pods", async () => {
  const calls = [];
  const provider = {
    listPods: async () => { calls.push("list"); return [{ id: "a", name: "agentcloud-job-1" }, { id: "b", name: "other" }]; },
    terminatePod: async () => { calls.push("terminate"); },
    createPod: async () => { calls.push("create"); },
  };
  assert.deepEqual(await checkRunpodAccess(provider), { total: 2, managed: 1 });
  assert.deepEqual(calls, ["list"]);
});
