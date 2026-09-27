import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diskOptionsGib, machines, minDiskGib } from "../lib/machine-catalog.mjs";

// The worker IAM policy (infra/aws/cpu.tf) must allow exactly the catalog's instance types
// per launch template, and the root-volume ceiling must equal the largest catalog disk.
const cpuTf = readFileSync(new URL("../infra/aws/cpu.tf", import.meta.url), "utf8");
const gpuEnvTf = readFileSync(new URL("../infra/aws/gpu-env.tf", import.meta.url), "utf8");
const list = (name) => JSON.parse(cpuTf.match(new RegExp(`${name}\\s*=\\s*(\\[[^\\]]*\\])`))[1]);

test("Terraform instance-type allowlists equal the machine catalog, per template", () => {
  const types = (template) => machines.filter((machine) => machine.launchTemplate === template).map((machine) => machine.instanceType).sort();
  assert.deepEqual(list("catalog_cpu_instance_types").sort(), types("agentcloud-demo-cpu"));
  assert.deepEqual(list("catalog_gpu_instance_types").sort(), types("agentcloud-demo-gpu-env"));
  assert.equal(Number(cpuTf.match(/catalog_max_disk_gib\s*=\s*(\d+)/)[1]), Math.max(...diskOptionsGib));
});

test("the GPU environment template's default type and root volume are valid for the catalog", () => {
  assert.match(gpuEnvTf, /name = "agentcloud-demo-gpu-env"/);
  const type = gpuEnvTf.match(/instance_type\s*=\s*"([^"]+)"/)[1];
  const machine = machines.find((item) => item.instanceType === type);
  assert.equal(machine?.launchTemplate, "agentcloud-demo-gpu-env");
  const volume = Number(gpuEnvTf.match(/volume_size\s*=\s*(\d+)/)[1]);
  assert.ok(volume >= minDiskGib(machine) && volume <= Math.max(...diskOptionsGib));
  // Every GPU size fits the account's 4-vCPU G quota.
  for (const gpu of machines.filter((item) => item.kind === "gpu")) assert.ok(gpu.vcpu <= 4, gpu.id);
});
