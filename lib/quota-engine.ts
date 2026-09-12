import { sql } from './db';
import type { MembershipState } from './membership';
import type postgres from 'postgres';

export type QuotaKey =
  | 'chat_reply'
  | 'message_send'
  | 'character_create'
  | 'voice_reply'
  | 'voice_letter'
  | 'theater_session'
  | 'theater_reply'
  | 'voice_clone'

export type QuotaPeriod = 'day' | 'month' | 'lifetime';

export type QuotaPolicy = {
  key: QuotaKey;
  limit: number;
  period: QuotaPeriod;
};

export type QuotaReservation = {
  transactionId: string;
  key: QuotaKey;
  periodKey: string;
  limit: number;
  status: 'reserved' | 'committed';
};

export class QuotaExceededError extends Error {
  constructor(public readonly key: QuotaKey) {
    super(`Quota exceeded for ${key}.`);
  }
}

export function quotaPolicy(key: QuotaKey, membership: MembershipState): QuotaPolicy {
  switch (key) {
    case 'chat_reply':
      return { key, period: 'day', limit: membership.limits.dailyChatReplies };
    case 'message_send':
      return { key, period: 'day', limit: membership.limits.dailyMessageSends };
    case 'character_create':
      return { key, period: 'lifetime', limit: membership.limits.maxProfiles };
    case 'voice_reply':
      return { key, period: 'day', limit: membership.limits.dailyTTS };
    case 'voice_letter':
      return membership.isMember
        ? { key, period: 'day', limit: membership.limits.dailyVoiceLetters }
        : { key, period: 'lifetime', limit: 1 };
    case 'theater_session':
      return membership.isMember
        ? { key, period: 'day', limit: membership.limits.dailyTheaterSessions }
        : { key, period: 'lifetime', limit: 1 };
    case 'theater_reply':
      // A member can open up to five sessions per day and each session may
      // contain at most twenty partner replies.  The ledger is currently
      // user/day scoped, so reserve the equivalent daily capacity here; the
      // client/session flow enforces the per-session 20-round cap.
      return {
        key,
        period: 'day',
        limit: membership.isMember
          ? membership.limits.dailyTheaterSessions * 20
          : 20
      };
    case 'voice_clone':
      return { key, period: 'month', limit: membership.limits.monthlyVoiceClones };
  }
}

async function serverPeriodKeys() {
  const rows = await sql<{ day_key: string; month_key: string }[]>`
    select current_date::text as day_key, to_char(current_date, 'YYYY-MM') as month_key
  `;
  // PostgreSQL always returns one row for this scalar SELECT, but keep the
  // quota path fail-safe if a proxy/driver unexpectedly yields an empty list.
  if (rows[0]) return rows[0];
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  return { day_key: dayKey, month_key: dayKey.slice(0, 7) };
}

async function periodKeyFor(period: QuotaPeriod) {
  if (period === 'lifetime') return 'lifetime';
  const keys = await serverPeriodKeys();
  return period === 'month' ? keys.month_key : keys.day_key;
}

export async function reserveQuota(params: {
  userId: string;
  key: QuotaKey;
  idempotencyKey: string;
  membership: MembershipState;
  metadata?: postgres.JSONValue;
}): Promise<QuotaReservation> {
  const policy = quotaPolicy(params.key, params.membership);
  if (policy.limit <= 0) throw new QuotaExceededError(params.key);
  const periodKey = await periodKeyFor(policy.period);
  const transactionId = crypto.randomUUID();

  return sql.begin(async (tx) => {
    const prior = await tx<{
      id: string;
      period_key: string;
      status: 'reserved' | 'committed' | 'released';
    }[]>`
      select id, period_key, status
      from quota_transactions
      where user_id = ${params.userId}
        and quota_key = ${params.key}
        and idempotency_key = ${params.idempotencyKey}
      limit 1
    `;
    if (prior[0]?.status === 'reserved' || prior[0]?.status === 'committed') {
      return {
        transactionId: prior[0].id,
        key: params.key,
        periodKey: prior[0].period_key,
        limit: policy.limit,
        status: prior[0].status
      };
    }

    await tx`
      insert into quota_usage (user_id, quota_key, period_key)
      values (${params.userId}, ${params.key}, ${periodKey})
      on conflict (user_id, quota_key, period_key) do nothing
    `;
    const usage = await tx<{ reserved_count: number }[]>`
      update quota_usage
      set reserved_count = reserved_count + 1, updated_at = now()
      where user_id = ${params.userId}
        and quota_key = ${params.key}
        and period_key = ${periodKey}
        and used_count + reserved_count < ${policy.limit}
      returning reserved_count
    `;
    if (!usage[0]) throw new QuotaExceededError(params.key);

    await tx`
      insert into quota_transactions (
        id, user_id, quota_key, period_key, idempotency_key, status, metadata
      ) values (
        ${transactionId}, ${params.userId}, ${params.key}, ${periodKey},
        ${params.idempotencyKey}, 'reserved', ${tx.json(params.metadata ?? {})}
      )
    `;
    return {
      transactionId,
      key: params.key,
      periodKey,
      limit: policy.limit,
      status: 'reserved' as const
    };
  });
}

export async function commitQuota(transactionId: string) {
  await finishReservation(transactionId, 'committed');
}

export async function releaseQuota(transactionId: string) {
  await finishReservation(transactionId, 'released');
}

async function finishReservation(transactionId: string, target: 'committed' | 'released') {
  await sql.begin(async (tx) => {
    const rows = await tx<{
      user_id: string;
      quota_key: string;
      period_key: string;
      amount: number;
      status: string;
    }[]>`
      select user_id, quota_key, period_key, amount, status
      from quota_transactions
      where id = ${transactionId}
      for update
    `;
    const row = rows[0];
    if (!row || row.status !== 'reserved') return;

    await tx`
      update quota_transactions
      set status = ${target}, updated_at = now()
      where id = ${transactionId}
    `;
    await tx`
      update quota_usage
      set reserved_count = greatest(reserved_count - ${row.amount}, 0),
          used_count = used_count + ${target === 'committed' ? row.amount : 0},
          updated_at = now()
      where user_id = ${row.user_id}
        and quota_key = ${row.quota_key}
        and period_key = ${row.period_key}
    `;
  });
}

export async function getQuotaSnapshots(userId: string, membership: MembershipState) {
  const keys: QuotaKey[] = [
    'chat_reply',
    'message_send',
    'character_create',
    'voice_reply',
    'voice_letter',
    'theater_session',
    'theater_reply',
    'voice_clone'
  ];
  const periods = await serverPeriodKeys();
  const periodFor = (period: QuotaPeriod) => period === 'lifetime'
    ? 'lifetime'
    : period === 'month' ? periods.month_key : periods.day_key;
  const rows = await sql<{ quota_key: QuotaKey; period_key: string; used_count: number; reserved_count: number }[]>`
    select quota_key, period_key, used_count, reserved_count
    from quota_usage
    where user_id = ${userId}
      and period_key in ('lifetime', ${periods.day_key}, ${periods.month_key})
  `;
  const byKey = new Map(rows.map((row) => [`${row.quota_key}:${row.period_key}`, row]));
  return keys.map((key) => {
    const policy = quotaPolicy(key, membership);
    const periodKey = periodFor(policy.period);
    const row = byKey.get(`${key}:${periodKey}`);
    return {
      key,
      period: policy.period,
      periodKey,
      limit: policy.limit,
      used: row?.used_count ?? 0,
      reserved: row?.reserved_count ?? 0
    };
  });
}
