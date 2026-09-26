import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { localWatchdogReady } from "../scripts/runpod-local-watchdog.mjs";

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
