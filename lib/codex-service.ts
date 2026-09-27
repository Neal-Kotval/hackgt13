import { getDatabase } from './auth.mjs';
import { createCodexSessionService, CodexSessionError } from './codex-sessions.mjs';
import { createCodexDockerRuntime, stopCodexContainer } from './codex-docker.mjs';
import { createCodexSshRuntime } from './codex-ssh.mjs';
import { createRunBoxTargets } from './codex-targets.mjs';
import { AgentInboxError } from './agent-inbox.mjs';
import { onRunBoxStopRequested } from './run-box-jobs.mjs';
import { failure } from './http';
import { InputError } from './store';

// AGENTCLOUD_CODEX_ENABLED=1 gates local Docker Codex boxes only. Remote sessions
// (HAC-153) run on a ready environment over SSH and need no flag.
const LOCAL_DISABLED = 'Local Codex boxes are disabled on this server.';
export const codexEnabled = () => process.env.AGENTCLOUD_CODEX_ENABLED === '1';
type RuntimeOptions = { sessionId: string; installId: string; runBoxId?: string | null; agentId?: string; agentWorktree?: boolean;
  onNotification: (method: string, params: unknown) => void; onExit: (event: { message: string }) => void };
const shared = globalThis as typeof globalThis & { agentcloudCodexService?: ReturnType<typeof createCodexSessionService> };
export function codexService() {
  return shared.agentcloudCodexService ??= (() => {
    const db = getDatabase();
    return createCodexSessionService({
      db,
      runtimeFactory: (options: RuntimeOptions) => {
        if (options.runBoxId) return createCodexSshRuntime({ ...options, runBoxId: options.runBoxId }, { db });
        if (!codexEnabled()) throw Object.assign(new CodexSessionError(LOCAL_DISABLED, 503), { publicMessage: LOCAL_DISABLED });
        return createCodexDockerRuntime(options as Parameters<typeof createCodexDockerRuntime>[0]);
      },
      stopFactory: stopCodexContainer,
      targets: createRunBoxTargets(db),
      onStopRequested: onRunBoxStopRequested,
      dataDir: process.env.AGENTCLOUD_DATA_DIR || '.agentcloud',
      apiKey: process.env.AGENTCLOUD_CODEX_API_KEY || '', model: process.env.AGENTCLOUD_CODEX_MODEL,
    });
  })();
}
export function codexFailure(error: unknown) {
  if (error instanceof CodexSessionError) return Response.json({error:error.message,code:error.code},{status:error.status});
  if (error instanceof AgentInboxError) return Response.json({error:error.message,code:error.code},{status:error.status});
  // Protocol/Docker/SSH errors can contain provider text. Do not expose or log raw errors.
  if (error instanceof InputError) return failure(error);
  return Response.json({error:'Codex operation failed. Reconnect and try again.'},{status:502});
}
