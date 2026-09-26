import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunpodProvider,
  RunpodAmbiguousCreateError,
  runpodJobMarker,
  runpodPodName,
} from "../lib/runpod-provider.mjs";

const key = "unit-test-runpod-key";
const jobId = "12345678-1234-1234-1234-123456789abc";
const expiresAt = "2026-09-26T22:00:00.000Z";
const spec = { jobId, expiresAt, gpuId: "NVIDIA GeForce RTX 4090", image: "runpod/pytorch:test", dataCenterId: "US-KS-2", diskGb: 40 };
const pod = (overrides = {}) => ({
  id: "pod123", name: runpodPodName(jobId, expiresAt), status: "RUNNING", image: spec.image,
  gpu: { id: spec.gpuId, count: 1 }, disk: 40, cloud: "SECURE", dataCenterId: spec.dataCenterId,
  env: { PRIVATE_TOKEN: "never-return-this" },
  ssh: { direct: { host: "203.0.113.10", port: 30222, username: "root", command: "ssh root@203.0.113.10" }, proxy: null },
  ...overrides,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const list = (pods, nextCursor = null) => json({ pods, pagination: { nextCursor, hasNextPage: Boolean(nextCursor) } });

function harness(responses) {
  const calls = [];
  const provider = createRunpodProvider({
    apiKey: key,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body, redirect: options.redirect });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("Unexpected mock request");
      return next;
    },
  });
  return { provider, calls, remaining: responses };
}

test("v2 catalog, list, get, and terminate use bearer auth and expose only safe pod fields", async () => {
  const h = harness([
    json({ gpus: [{ id: spec.gpuId, name: "RTX 4090", memory: 24, price: { secure: 0.44 }, availability: "HIGH", dataCenters: [{ id: "US-KS-2", availability: "HIGH" }] }] }),
    json({ dataCenters: [{ id: "US-KS-2", region: "NORTH_AMERICA", gpuAvailability: [{ id: spec.gpuId, availability: "HIGH" }] }] }),
    list([pod()]),
    json(pod()),
    new Response(null, { status: 204 }),
  ]);
  assert.equal((await h.provider.listGpuTypes())[0].secureHourlyUsd, 0.44);
  assert.equal((await h.provider.listDataCenters("NORTH_AMERICA"))[0].id, "US-KS-2");
  const listed = (await h.provider.listPods())[0];
  assert.deepEqual(listed.ssh.direct, { host: "203.0.113.10", port: 30222, username: "root" });
  assert.equal(JSON.stringify(listed).includes("PRIVATE_TOKEN"), false);
  assert.equal((await h.provider.getPod("pod123")).id, "pod123");
  assert.deepEqual(await h.provider.terminatePod("pod123"), { id: "pod123", terminated: true, alreadyAbsent: false });
  assert.deepEqual(h.calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ["GET", "/v2/catalog/gpus"], ["GET", "/v2/catalog/datacenters"], ["GET", "/v2/pods"],
    ["GET", "/v2/pods/pod123"], ["DELETE", "/v2/pods/pod123"],
  ]);
  assert.equal(new URL(h.calls[0].url).searchParams.get("product"), "POD");
  assert.equal(new URL(h.calls[1].url).searchParams.get("regions"), "NORTH_AMERICA");
  for (const call of h.calls) {
    assert.equal(call.headers.Authorization, `Bearer ${key}`);
    assert.equal(call.redirect, "error");
  }
});

test("list walks every cursor before matching the deterministic job marker", async () => {
  const h = harness([list([pod({ id: "other", name: "unrelated" })], "cursor-2"), list([pod()])]);
  assert.equal((await h.provider.findPodByJobId(jobId)).id, "pod123");
  assert.equal(new URL(h.calls[1].url).searchParams.get("cursor"), "cursor-2");
  assert.equal(h.calls.length, 2);
});

test("create reuses an exact existing pod and refuses a marker configuration conflict", async () => {
  const reused = harness([list([pod()])]);
  assert.equal((await reused.provider.createPod(spec)).id, "pod123");
  assert.deepEqual(reused.calls.map((call) => call.method), ["GET"]);
  const conflict = harness([list([pod({ image: "other/image" })])]);
  await assert.rejects(conflict.provider.createPod(spec), (error) => error.code === "marker_conflict");
  assert.deepEqual(conflict.calls.map((call) => call.method), ["GET"]);
});

test("create sends v2 body with one GPU, SSH access, and no browser-controlled secrets", async () => {
  const h = harness([list([]), json(pod({ status: "PROVISIONING" }), 201)]);
  await assert.rejects(h.provider.createPod({ ...spec, env: { API_KEY: "not-forwarded" } }), /Invalid Runpod environment/);
  await assert.rejects(h.provider.createPod({ ...spec, cmd: "bash -c evil" }), /Invalid Runpod start command/);
  assert.equal(h.calls.length, 0);
  const result = await h.provider.createPod({ ...spec, name: "ignored" });
  assert.equal(result.status, "PROVISIONING");
  const body = JSON.parse(h.calls[1].body);
  assert.deepEqual(body, {
    name: runpodPodName(jobId, expiresAt), image: spec.image, gpu: { id: spec.gpuId, count: 1 },
    disk: 40, cloud: "SECURE", startSsh: true, ports: ["22/tcp"], dataCenterIds: ["US-KS-2"],
  });
  assert.equal(h.calls[1].method, "POST");
  assert.equal(h.calls[1].headers["Content-Type"], "application/json");
});

test("create forwards worker-owned AGENTCLOUD env and start command, never in returned pod", async () => {
  const h = harness([list([]), json(pod({ status: "PROVISIONING", env: { AGENTCLOUD_SSH_HOST_KEY_B64: "secret" } }), 201)]);
  const env = { AGENTCLOUD_SSH_HOST_KEY_B64: "c2VjcmV0", AGENTCLOUD_AUTHORIZED_KEYS_B64: "a2V5cw==" };
  const result = await h.provider.createPod({ ...spec, env, cmd: ["bash", "-c", "exec /start.sh"] });
  const body = JSON.parse(h.calls[1].body);
  assert.deepEqual(body.env, env);
  assert.deepEqual(body.cmd, ["bash", "-c", "exec /start.sh"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("expiry marker is stable, bounded, and required before allocation", async () => {
  assert.equal(runpodJobMarker(jobId), `agentcloud-${jobId}--exp-`);
  assert.equal(runpodPodName(jobId, expiresAt), `agentcloud-${jobId}--exp-1790460000`);
  assert.ok(runpodPodName(jobId, expiresAt).length <= 63);
  assert.throws(() => runpodPodName(jobId, "invalid"), /expiry/);
  assert.throws(() => runpodJobMarker("not-a-uuid"), /job ID/);
  const differentDeadline = harness([list([pod()])]);
  await assert.rejects(differentDeadline.provider.createPod({ ...spec, expiresAt: "2026-09-26T23:00:00.000Z" }),
    (error) => error.code === "marker_conflict");
  assert.deepEqual(differentDeadline.calls.map((call) => call.method), ["GET"]);
});

test("lost create response reconciles the marker without issuing a second POST", async () => {
  const h = harness([list([]), new Error(`network failed ${key}`), list([pod()])]);
  assert.equal((await h.provider.createPod(spec)).id, "pod123");
  assert.deepEqual(h.calls.map((call) => call.method), ["GET", "POST", "GET"]);
});

test("uncertain create with no visible pod or duplicate markers fails closed", async () => {
  const absent = harness([list([]), new Error("timeout"), list([])]);
  await assert.rejects(absent.provider.createPod(spec), RunpodAmbiguousCreateError);
  assert.equal(absent.calls.filter((call) => call.method === "POST").length, 1);
  const duplicate = harness([list([pod(), pod({ id: "pod456" })])]);
  await assert.rejects(duplicate.provider.createPod(spec), RunpodAmbiguousCreateError);
  assert.equal(duplicate.calls.filter((call) => call.method === "POST").length, 0);
  const timedOut = harness([list([]), json({ detail: "request timed out" }, 408), list([])]);
  await assert.rejects(timedOut.provider.createPod(spec), RunpodAmbiguousCreateError);
  assert.equal(timedOut.calls.filter((call) => call.method === "POST").length, 1);
});

test("upstream errors and malformed replies never expose API keys or response bodies", async () => {
  const rejected = harness([json({ detail: `Bearer ${key}` }, 403)]);
  await assert.rejects(rejected.provider.listPods(), (error) => error.status === 403 && !String(error).includes(key));
  const malformed = harness([json({ pods: [] })]);
  await assert.rejects(malformed.provider.listPods(), (error) => error.code === "invalid_response");
  const missing = harness([json({ detail: "not found" }, 404), json({ detail: "not found" }, 404)]);
  assert.equal(await missing.provider.getPod("pod123"), null);
  assert.deepEqual(await missing.provider.terminatePod("pod123"), { id: "pod123", terminated: true, alreadyAbsent: true });
});
