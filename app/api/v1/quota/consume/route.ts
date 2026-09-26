import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { commitQuota, quotaTimeZoneFromRequest, QuotaExceededError, reserveQuota } from '@/lib/quota-engine';
import { getMembership } from '@/lib/membership';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  logIncomingRequest('quota.consume', request);
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = await request.json().catch(() => ({}));
    const timeZone = quotaTimeZoneFromRequest(request);
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
    const key = kindRaw === 'tts'
      ? 'voice_reply'
      : kindRaw === 'voice_clone'
        ? 'voice_clone'
        : kindRaw === 'theater_session'
          ? 'theater_session'
          : 'chat_reply';
    const membership = await getMembership(auth.userId);
    const reservation = await reserveQuota({
      userId: auth.userId,
      key,
      idempotencyKey: request.headers.get('x-aidol-request-id')?.trim() || crypto.randomUUID(),
      membership,
      timeZone,
      metadata: { source: 'quota.consume', kind: kindRaw }
    });
    await commitQuota(reservation.transactionId);
    return ok({ kind: kindRaw, quota: { limit: reservation.limit } });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return fail(`${error.key} quota exceeded.`, 403, `${error.key.toUpperCase()}_LIMIT`);
    }
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'QUOTA_CONSUME_FAILED');
  }
}
