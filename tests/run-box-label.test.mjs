import assert from "node:assert/strict";
import test from "node:test";
import { runBoxHardwareLabel } from "../components/resources/run-box-label.ts";

const gpu = { "runpod-rtx-4090": "Runpod Secure Cloud · RTX 4090", "g6-l4-small": "AWS EC2 · Small GPU · NVIDIA L4" };

test("a local Docker run box is labelled as a CPU-only local sandbox, never a GPU", () => {
  assert.equal(runBoxHardwareLabel({ provider: "docker-local", profile_id: "local-docker-sandbox" }, gpu), "Local sandbox · CPU only");
  assert.equal(runBoxHardwareLabel({ provider: "docker-local", profile_id: null }, gpu), "Local sandbox · CPU only");
});

test("GPU wording appears only for GPU profiles", () => {
  assert.equal(runBoxHardwareLabel({ provider: "runpod", profile_id: "runpod-rtx-4090" }, gpu), "GPU · Runpod Secure Cloud · RTX 4090");
  assert.equal(runBoxHardwareLabel({ provider: "aws-ec2", profile_id: "g6-l4-small" }, gpu), "GPU · AWS EC2 · Small GPU · NVIDIA L4");
  assert.equal(runBoxHardwareLabel({ provider: "aws-ec2", profile_id: null }, gpu), "GPU · AWS EC2");
  assert.equal(runBoxHardwareLabel({ provider: "aws-ec2", profile_id: "ec2-cpu-small" }, gpu), "AWS EC2 · CPU only");
});
