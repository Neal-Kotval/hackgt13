import { requireEmployee, requireMembership } from '@/lib/employee';
import { codexFailure, codexService } from '@/lib/codex-service';
import { listChatRuns } from '@/lib/chat-runs.mjs';
import { InputError } from '@/lib/store';
import { getDatabase } from '@/lib/auth.mjs';
import { runBoxVisibleTo } from '@/lib/run-box-access.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (!projectId?.trim() || projectId.length > 256) throw new InputError('Choose a project.', 400);
    requireMembership(employee, projectId);
    return Response.json({ runs: listChatRuns(codexService(), projectId, {
      // Environment model: runs on deleted or other people's private environments are omitted.
      canSeeRunBox: (runBoxId: string) => runBoxVisibleTo(getDatabase(), employee, runBoxId),
    }) }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return codexFailure(error);
  }
}
