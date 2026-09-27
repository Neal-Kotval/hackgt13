import { getDatabase } from './auth.mjs';
import { createCodexSessionService, CodexSessionError } from './codex-sessions.mjs';
import { createCodexDockerRuntime, stopCodexContainer } from './codex-docker.mjs';
import { failure } from './http';
import { InputError } from './store';

export const codexEnabled = () => process.env.AGENTCLOUD_CODEX_ENABLED === '1';
const shared = globalThis as typeof globalThis & { agentcloudCodexService?: ReturnType<typeof createCodexSessionService> };
export function codexService() {
  if (!codexEnabled()) throw new CodexSessionError('Local Codex boxes are disabled on this server.', 503);
  return shared.agentcloudCodexService ??= createCodexSessionService({
    db: getDatabase(), runtimeFactory: createCodexDockerRuntime, stopFactory: stopCodexContainer,
    dataDir: process.env.AGENTCLOUD_DATA_DIR || '.agentcloud',
    apiKey: process.env.AGENTCLOUD_CODEX_API_KEY || '', model: process.env.AGENTCLOUD_CODEX_MODEL,
  });
}
export function codexFailure(error: unknown) {
  if (error instanceof CodexSessionError) return Response.json({error:error.message,code:error.code},{status:error.status});
  // Protocol/Docker errors can contain provider text. Do not expose or log raw errors.
  if (error instanceof InputError) return failure(error);
  return Response.json({error:'Codex operation failed. Check Docker and reconnect.'},{status:502});
}
