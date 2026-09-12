import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { assertAndConsumeQuota } from '@/lib/quota';
import { commitQuota, QuotaExceededError, reserveQuota } from '@/lib/quota-engine';
import { getMembership } from '@/lib/membership';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  logIncomingRequest('quota.consume', request);
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = await request.json().catch(() => ({}));
    const kindRaw = String(body.kind || '').trim();
    if (kindRaw === 'character_create') {
      const membership = await getMembership(auth.userId);
      const reservation = await reserveQuota({
        userId: auth.userId,
        key: 'character_create',
        idempotencyKey: request.headers.get('x-aidol-request-id')?.trim() || crypto.randomUUID(),
        membership
      });
      await commitQuota(reservation.transactionId);
      return ok({ kind: kindRaw, quota: { limit: reservation.limit } });
    }
    const kind = kindRaw === 'tts'
      ? 'tts'
      : kindRaw === 'theater_session'
        ? 'theater_session'
        : 'chat';

    const quota = await assertAndConsumeQuota(auth.userId, kind);
    return ok({ kind, quota });
  } catch (error) {
    if (error instanceof QuotaExceededError) return fail('Character creation limit reached.', 403, 'CHARACTER_CREATE_LIMIT');
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'QUOTA_CONSUME_FAILED');
  }
}
