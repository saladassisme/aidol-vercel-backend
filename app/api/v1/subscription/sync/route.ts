import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { fetchAppleTransactionInfo, upsertSubscriptionFromApple } from '@/lib/apple';
import { getMembership } from '@/lib/membership';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = await request.json().catch(() => ({}));
    const rawIds = Array.isArray(body.transactionIds) ? body.transactionIds : [];
    const transactionIds = rawIds
      .map((value: unknown) => String(value).trim())
      .filter((value: string) => value.length > 0);

    const synced: string[] = [];
    const errors: string[] = [];

    for (const transactionId of transactionIds) {
      try {
        const info = await fetchAppleTransactionInfo(transactionId);
        await upsertSubscriptionFromApple(auth.userId, info);
        synced.push(transactionId);
      } catch (error) {
        errors.push(
          `${transactionId}: ${error instanceof Error ? error.message : 'verify failed'}`
        );
      }
    }

    const membership = await getMembership(auth.userId);
    return ok({ membership, synced, errors });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'SUBSCRIPTION_SYNC_FAILED');
  }
}
