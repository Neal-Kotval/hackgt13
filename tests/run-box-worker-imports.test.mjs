import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Live regression: the worker called cleanupGate() without importing it, so every aws-ec2
// cycle failed with "cleanupGate is not defined" (node --check does not resolve bindings,
// and only the docker-local path was smoke-run). Any lib export the worker calls must be imported.
test("run-box-worker imports every lib function it calls", async () => {
  const source = readFileSync(new URL("../scripts/run-box-worker.mjs", import.meta.url), "utf8");
  const imported = new Set([...source.matchAll(/import \{([^}]*)\} from "\.\.\/lib\/[\w-]+\.mjs"/g)]
    .flatMap((match) => match[1].split(",").map((name) => name.trim().split(/\s+as\s+/).pop()).filter(Boolean)));
  const missing = [];
  for (const module of ["run-box-reconcile", "run-box-jobs", "aws-cpu-worker", "aws-gpu-worker", "aws-force-close"]) {
    const exports = Object.keys(await import(`../lib/${module}.mjs`));
    for (const name of exports)
      if (new RegExp(`\\b${name}\\(`).test(source) && !imported.has(name)) missing.push(`${module}.${name}`);
  }
  assert.deepEqual(missing, []);
});
