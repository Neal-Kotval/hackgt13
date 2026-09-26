const DEFAULT_BASE_URL = "https://api.runpod.io/v2";
const MARKER_PREFIX = "agentcloud-";

export class RunpodApiError extends Error {
  constructor(message, { status = null, code = "api_error" } = {}) {
    super(message);
    this.name = "RunpodApiError";
    this.status = status;
    this.code = code;
  }
}

export class RunpodAmbiguousCreateError extends RunpodApiError {
  constructor() {
    super("Runpod create outcome is uncertain; reconcile the job marker before another create", { code: "ambiguous_create" });
    this.name = "RunpodAmbiguousCreateError";
  }
}

function nonempty(value, label, limit = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function podId(value) {
  const id = nonempty(value, "pod ID", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid pod ID");
  return id;
}

export function runpodJobMarker(jobId) {
  const id = nonempty(jobId, "job ID", 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid job ID");
  return `${MARKER_PREFIX}${id}--exp-`;
}

export function runpodPodName(jobId, expiresAt) {
  const prefix = runpodJobMarker(jobId);
  const milliseconds = new Date(expiresAt).getTime();
  const epochSeconds = Math.ceil(milliseconds / 1000);
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 1_000_000_000 || epochSeconds > 4_102_444_800)
    throw new Error("Invalid Runpod Pod expiry");
  return `${prefix}${epochSeconds}`;
}

function safePod(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.name !== "string")
    throw new RunpodApiError("Runpod returned an invalid pod", { code: "invalid_response" });
  // Do not return env, commands, registry credentials, or raw upstream errors.
  return {
    id: podId(value.id),
    name: value.name,
    status: typeof value.status === "string" ? value.status : null,
    image: typeof value.image === "string" ? value.image : null,
    diskGb: Number.isInteger(value.disk) ? value.disk : null,
    gpuId: typeof value.gpu?.id === "string" ? value.gpu.id : null,
    gpuCount: Number.isInteger(value.gpu?.count) ? value.gpu.count : null,
    cloud: typeof value.cloud === "string" ? value.cloud : null,
    dataCenterId: typeof value.dataCenterId === "string" ? value.dataCenterId : null,
    ssh: {
      proxy: safeSshEndpoint(value.ssh?.proxy),
      direct: safeSshEndpoint(value.ssh?.direct),
    },
  };
}

function safeSshEndpoint(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.host !== "string" || typeof value.username !== "string" || !Number.isInteger(value.port)) return null;
  return { host: value.host, port: value.port, username: value.username };
}

// Only worker-owned AGENTCLOUD_* variables are forwarded. Values may carry per-job
// secrets (a generated host key), so they are never logged or returned by safePod.
function createEnv(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Runpod environment");
  const entries = Object.entries(value);
  if (entries.length > 16) throw new Error("Invalid Runpod environment");
  for (const [name, item] of entries)
    if (!/^AGENTCLOUD_[A-Z0-9_]{1,64}$/.test(name) || typeof item !== "string" || item.length > 16384)
      throw new Error("Invalid Runpod environment");
  return Object.fromEntries(entries);
}

function createCmd(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length || value.length > 8 ||
      value.some((item) => typeof item !== "string" || !item || item.length > 8192))
    throw new Error("Invalid Runpod start command");
  return [...value];
}

function createSpec(input) {
  if (!input || typeof input !== "object") throw new Error("Invalid Runpod create specification");
  const name = runpodPodName(input.jobId, input.expiresAt);
  const gpuId = nonempty(input.gpuId, "GPU ID", 128);
  const image = nonempty(input.image, "container image", 512);
  const diskGb = input.diskGb ?? 50;
  if (!Number.isInteger(diskGb) || diskGb < 1 || diskGb > 500) throw new Error("Invalid container disk size");
  const cloud = input.cloud ?? "SECURE";
  if (!["SECURE", "COMMUNITY"].includes(cloud)) throw new Error("Invalid cloud tier");
  const dataCenterId = input.dataCenterId === undefined ? null : nonempty(input.dataCenterId, "data center ID", 80);
  const env = createEnv(input.env);
  const cmd = createCmd(input.cmd);
  const body = {
    name,
    image,
    gpu: { id: gpuId, count: 1 },
    disk: diskGb,
    cloud,
    startSsh: true,
    ports: ["22/tcp"],
    ...(dataCenterId ? { dataCenterIds: [dataCenterId] } : {}),
    // Runpod v2 ContainerConfig: `env` is a key/value object; `cmd` replaces the image CMD
    // (exec form) while keeping the image ENTRYPOINT.
    ...(env ? { env } : {}),
    ...(cmd ? { cmd } : {}),
  };
  return { body, name, gpuId, image, cloud, diskGb };
}

function assertMatchingPod(pod, spec) {
  if (pod.name !== spec.name || pod.gpuId !== spec.gpuId || pod.gpuCount !== 1 ||
      pod.image !== spec.image || pod.cloud !== spec.cloud || pod.diskGb !== spec.diskGb)
    throw new RunpodApiError("A pod with this job marker has a different configuration", { code: "marker_conflict" });
}

export function createRunpodProvider({ apiKey, fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL, timeoutMs = 30_000 } = {}) {
  const key = nonempty(apiKey, "Runpod API key", 2048);
  if (/[\r\n]/.test(key)) throw new Error("Invalid Runpod API key");
  if (typeof fetchImpl !== "function") throw new Error("Invalid fetch implementation");
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== "https:" || parsedBase.username || parsedBase.password || parsedBase.search ||
      parsedBase.hash || parsedBase.pathname !== "/v2") throw new Error("Invalid Runpod API base URL");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("Invalid Runpod timeout");

  async function request(method, pathname, body = undefined, query = undefined) {
    const url = new URL(`${parsedBase.origin}/v2${pathname}`);
    for (const [name, value] of Object.entries(query || {})) if (value !== undefined) url.searchParams.set(name, String(value));
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RunpodApiError("Runpod request outcome is unknown", { code: "transport" });
    }
    if (!response || typeof response.status !== "number")
      throw new RunpodApiError("Runpod returned an invalid response", { code: "invalid_response" });
    if (response.status === 204) return { status: 204, data: null };
    let data = null;
    try { data = await response.json(); }
    catch {
      if (response.ok) throw new RunpodApiError("Runpod returned invalid JSON", { code: "invalid_response" });
    }
    if (!response.ok) throw new RunpodApiError(`Runpod request failed with HTTP ${response.status}`, { status: response.status });
    return { status: response.status, data };
  }

  async function listPods() {
    const pods = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 1000; page++) {
      const { data } = await request("GET", "/pods", undefined, cursor ? { cursor } : undefined);
      if (!Array.isArray(data?.pods) || !data.pagination || typeof data.pagination !== "object")
        throw new RunpodApiError("Runpod returned an invalid pod list", { code: "invalid_response" });
      pods.push(...data.pods.map(safePod));
      if (!data.pagination.hasNextPage) return pods;
      cursor = data.pagination.nextCursor;
      if (typeof cursor !== "string" || !cursor || seen.has(cursor))
        throw new RunpodApiError("Runpod returned an invalid pagination cursor", { code: "invalid_response" });
      seen.add(cursor);
    }
    throw new RunpodApiError("Runpod pod listing exceeded the page limit", { code: "invalid_response" });
  }

  async function findPodByJobId(jobId) {
    const marker = runpodJobMarker(jobId);
    const matches = (await listPods()).filter((pod) => pod.name.startsWith(marker) && /^\d{10}$/.test(pod.name.slice(marker.length)));
    if (matches.length > 1) throw new RunpodAmbiguousCreateError();
    return matches[0] || null;
  }

  async function createPod(input, { onBeforePost } = {}) {
    const spec = createSpec(input);
    if (onBeforePost !== undefined && typeof onBeforePost !== "function") throw new Error("Invalid Runpod create callback");
    const existing = await findPodByJobId(input.jobId);
    if (existing) {
      assertMatchingPod(existing, spec);
      return existing;
    }
    if (onBeforePost) await onBeforePost();
    try {
      const { status, data } = await request("POST", "/pods", spec.body);
      if (status !== 201) throw new RunpodApiError("Runpod create returned an unexpected status", { status, code: "invalid_response" });
      const created = safePod(data);
      assertMatchingPod(created, spec);
      return created;
    } catch (error) {
      if (error instanceof RunpodApiError && error.code === "marker_conflict") throw new RunpodAmbiguousCreateError();
      if (error instanceof RunpodApiError && error.status && error.status < 500 &&
          ![408, 429].includes(error.status) && error.code !== "invalid_response") throw error;
      // A POST may have committed before its response was lost. Inspect every page,
      // but never issue another POST when the result remains uncertain.
      let recovered;
      try { recovered = await findPodByJobId(input.jobId); }
      catch { throw new RunpodAmbiguousCreateError(); }
      if (!recovered) throw new RunpodAmbiguousCreateError();
      assertMatchingPod(recovered, spec);
      return recovered;
    }
  }

  async function getPod(id) {
    try {
      const { data } = await request("GET", `/pods/${encodeURIComponent(podId(id))}`);
      return safePod(data);
    } catch (error) {
      if (error instanceof RunpodApiError && error.status === 404) return null;
      throw error;
    }
  }

  async function terminatePod(id) {
    const safeId = podId(id);
    try {
      const { status } = await request("DELETE", `/pods/${encodeURIComponent(safeId)}`);
      if (status !== 204) throw new RunpodApiError("Runpod terminate returned an unexpected status", { status, code: "invalid_response" });
      return { id: safeId, terminated: true, alreadyAbsent: false };
    } catch (error) {
      if (error instanceof RunpodApiError && error.status === 404) return { id: safeId, terminated: true, alreadyAbsent: true };
      throw error;
    }
  }

  async function listGpuTypes() {
    const { data } = await request("GET", "/catalog/gpus", undefined, { include: "AVAILABILITY", product: "POD", count: 1 });
    if (!Array.isArray(data?.gpus)) throw new RunpodApiError("Runpod returned an invalid GPU catalog", { code: "invalid_response" });
    return data.gpus.map((gpu) => ({
      id: nonempty(gpu.id, "GPU ID", 128),
      name: typeof gpu.name === "string" ? gpu.name : null,
      memoryGb: typeof gpu.memory === "number" ? gpu.memory : null,
      availability: typeof gpu.availability === "string" ? gpu.availability : null,
      secureHourlyUsd: typeof gpu.price?.secure === "number" ? gpu.price.secure : null,
      communityHourlyUsd: typeof gpu.price?.community === "number" ? gpu.price.community : null,
      dataCenters: Array.isArray(gpu.dataCenters) ? gpu.dataCenters.map((item) => ({ id: item.id, availability: item.availability })) : [],
    }));
  }

  async function listDataCenters(region = undefined) {
    const { data } = await request("GET", "/catalog/datacenters", undefined,
      { include: "GPU_AVAILABILITY", ...(region ? { regions: nonempty(region, "region", 80) } : {}) });
    if (!Array.isArray(data?.dataCenters)) throw new RunpodApiError("Runpod returned an invalid data center catalog", { code: "invalid_response" });
    return data.dataCenters.map((center) => ({
      id: nonempty(center.id, "data center ID", 80),
      region: typeof center.region === "string" ? center.region : null,
      gpuAvailability: Array.isArray(center.gpuAvailability) ? center.gpuAvailability.map((item) => ({ id: item.id, availability: item.availability })) : [],
    }));
  }

  return { listGpuTypes, listDataCenters, listPods, findPodByJobId, createPod, getPod, terminatePod };
}
