// The local simulation never inherits the shared AWS endpoint from Doppler.
const port = Number(process.env.AGENTCLOUD_SIM_PORT || 3002);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("AGENTCLOUD_SIM_PORT must be an integer from 1024 to 65535");
process.env.AGENTCLOUD_URL = `http://127.0.0.1:${port}`;
await import("./dev-aws.mjs");
