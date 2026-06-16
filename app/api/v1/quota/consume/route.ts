import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { assertAndConsumeQuota } from '@/lib/quota';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  logIncomingRequest('quota.consume', request);
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = await request.json().catch(() => ({}));
    const kindRaw = String(body.kind || '').trim();
    const kind = kindRaw === 'tts' ? 'tts' : 'chat';

    const quota = await assertAndConsumeQuota(auth.userId, kind);
    return ok({ kind, quota });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'QUOTA_CONSUME_FAILED');
  }
}

