import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { resolveAppleTransactionInfo, upsertSubscriptionFromApple } from '@/lib/apple';
import { getMembership } from '@/lib/membership';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';
export const maxDuration = 60;

type SyncTransactionInput = {
  transactionId?: string;
  originalTransactionId?: string;
};

function normalizeTransactions(body: Record<string, unknown>): SyncTransactionInput[] {
  const transactions: SyncTransactionInput[] = [];

  if (Array.isArray(body.transactions)) {
    for (const item of body.transactions) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const transactionId = String(record.transactionId ?? record.transaction_id ?? '').trim();
      const originalTransactionId = String(
        record.originalTransactionId ?? record.original_transaction_id ?? ''
      ).trim();
      if (transactionId || originalTransactionId) {
        transactions.push({
          transactionId: transactionId || undefined,
          originalTransactionId: originalTransactionId || undefined
        });
      }
    }
  }

  if (transactions.length === 0 && Array.isArray(body.transactionIds)) {
    for (const value of body.transactionIds) {
      const transactionId = String(value).trim();
      if (transactionId) {
        transactions.push({ transactionId });
      }
    }
  }

  const seen = new Set<string>();
  return transactions.filter((item) => {
    const key = `${item.transactionId ?? ''}|${item.originalTransactionId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function POST(request: Request) {
  logIncomingRequest('subscription.sync', request);
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const transactions = normalizeTransactions(body);

    const synced: string[] = [];
    const errors: string[] = [];

    for (const item of transactions) {
      const label = item.transactionId ?? item.originalTransactionId ?? 'unknown';
      try {
        const info = await resolveAppleTransactionInfo(item);
        await upsertSubscriptionFromApple(auth.userId, info);
        synced.push(label);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'verify failed';
        errors.push(`${label}: ${message}`);
        console.error('[aidol] subscription.sync failed', {
          userId: auth.userId,
          transaction: item,
          message
        });
      }
    }

    const membership = await getMembership(auth.userId);
    console.log('[aidol] subscription.sync result', {
      userId: auth.userId,
      requested: transactions.length,
      synced: synced.length,
      errors: errors.length,
      isMember: membership.isMember
    });

    return ok({ membership, synced, errors });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'SUBSCRIPTION_SYNC_FAILED');
  }
}
