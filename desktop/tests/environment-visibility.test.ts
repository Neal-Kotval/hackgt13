import assert from "node:assert/strict";
import test from "node:test";
import { readHideStopped, saveHideStopped, visibleEnvironments } from "../src/lib/environment-visibility.ts";

test("hides only stopped environments and preserves lifecycle warnings", () => {
  const jobs = (["ready", "stopping", "failed", "unknown", "stopped", "queued"] as const).map((state) => ({ state }));
  assert.deepEqual(visibleEnvironments(jobs, true).map((job) => job.state), ["ready", "stopping", "failed", "unknown", "queued"]);
  assert.equal(visibleEnvironments(jobs, false), jobs);
  assert.deepEqual(visibleEnvironments([{state: "stopped"}], true), []);
});

test("visibility preference defaults to hidden, persists explicit choices, and tolerates unavailable storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }});
    assert.equal(readHideStopped(), true);
    saveHideStopped(false);
    assert.equal(readHideStopped(), false);
    saveHideStopped(true);
    assert.equal(readHideStopped(), true);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage disabled"); } });
    assert.equal(readHideStopped(), true);
    assert.doesNotThrow(() => saveHideStopped(false));
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
