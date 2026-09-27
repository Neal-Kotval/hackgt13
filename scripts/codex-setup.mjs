import { prepareCodexImage } from '../lib/codex-docker.mjs';
await prepareCodexImage();
console.log('Local Codex image ready. Start the host backend with AGENTCLOUD_CODEX_ENABLED=1. Initialize a Codex agent from project Settings.');
