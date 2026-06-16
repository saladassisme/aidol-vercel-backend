import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { resolveAppleTransactionInfo, upsertSubscriptionFromApple } from '@/lib/apple';
import { getMembership } from '@/lib/membership';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  logIncomingRequest('subscription.verify', request);
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const transactionId = String(body.transactionId ?? '').trim();
    const originalTransactionId = String(body.originalTransactionId ?? '').trim();
    if (!transactionId && !originalTransactionId) {
      return fail('transactionId is required.', 400, 'MISSING_TRANSACTION_ID');
    }

    const info = await resolveAppleTransactionInfo({
      transactionId: transactionId || undefined,
      originalTransactionId: originalTransactionId || undefined
    });
    const subscription = await upsertSubscriptionFromApple(auth.userId, info);
    const membership = await getMembership(auth.userId);

    console.log('[aidol] subscription.verify success', {
      userId: auth.userId,
      transactionId: info.transactionId,
      originalTransactionId: info.originalTransactionId ?? info.transactionId,
      productId: info.productId,
      isMember: membership.isMember
    });

    return ok({ subscription, membership });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[aidol] subscription.verify failed', { message });
    return fail(message, 500, 'SUBSCRIPTION_VERIFY_FAILED');
  }
}
