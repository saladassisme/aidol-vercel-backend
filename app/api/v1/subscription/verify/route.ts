import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { fetchAppleTransactionInfo, upsertSubscriptionFromApple } from '@/lib/apple';
import { getMembership } from '@/lib/membership';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  logIncomingRequest('subscription.verify', request);
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = await request.json();
    const transactionId = String(body.transactionId || '').trim();
    if (!transactionId) return fail('transactionId is required.', 400, 'MISSING_TRANSACTION_ID');

    const info = await fetchAppleTransactionInfo(transactionId);
    const subscription = await upsertSubscriptionFromApple(auth.userId, info);
    const membership = await getMembership(auth.userId);

    return ok({ subscription, membership });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'SUBSCRIPTION_VERIFY_FAILED');
  }
}
