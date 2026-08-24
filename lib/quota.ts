import { sql } from './db';
import { optionalEnv, optionalEnvInt } from './env';
import { getMembership } from './membership';

export type UsageKind = 'chat' | 'tts' | 'voice_clone' | 'theater_session';

function columnFor(kind: UsageKind) {
  switch (kind) {
    case 'chat': return 'chat_reply_count';
    case 'tts': return 'tts_count';
    case 'voice_clone': return 'voice_clone_count';
    case 'theater_session': return 'theater_session_count';
  }
}

function limitFor(kind: UsageKind, limits: Awaited<ReturnType<typeof getMembership>>['limits']) {
  switch (kind) {
    case 'chat': return limits.dailyChatReplies;
    case 'tts': return limits.dailyTTS;
    case 'voice_clone': return limits.monthlyVoiceClones;
    case 'theater_session': return limits.dailyTheaterSessions;
  }
}

function chatReplyLimit(isMember: boolean) {
  return Math.max(optionalEnvInt(isMember ? 'MEMBER_DAILY_CHAT_LIMIT' : 'FREE_DAILY_CHAT_LIMIT', isMember ? 200 : 20), isMember ? 200 : 20);
}

let quotaSchemaReady: Promise<void> | null = null;

function ensureQuotaSchema() {
  // Schema changes must not run inside user requests. They can lock quota
  // tables and block the atomic usage update. Run migrations explicitly, or
  // opt in for local setup with AIDOL_AUTO_MIGRATE=true.
  if (process.env.NODE_ENV === 'production' || process.env.AIDOL_AUTO_MIGRATE !== 'true') {
    return Promise.resolve();
  }
  if (!quotaSchemaReady) {
    quotaSchemaReady = (async () => {
      await sql`
        alter table daily_usage
        add column if not exists theater_session_count int not null default 0
      `;
      await sql`
        alter table users
        add column if not exists tts_preview_used_at timestamptz
      `;
      await sql`
        alter table users
        add column if not exists voice_letter_trial_used_at timestamptz,
        add column if not exists theater_trial_used_at timestamptz
      `;
    })();
  }
  return quotaSchemaReady;
}

export async function getTodayUsage(userId: string) {
  await ensureQuotaSchema();
  const rows = await sql<{
    chat_reply_count: number;
    tts_count: number;
    voice_clone_count: number;
    theater_session_count: number;
  }[]>`
    with ensured as (
      insert into daily_usage (user_id, usage_date)
      values (${userId}, current_date)
      on conflict (user_id, usage_date) do nothing
    )
    select chat_reply_count, tts_count, voice_clone_count, theater_session_count
    from daily_usage
    where user_id = ${userId} and usage_date = current_date
    limit 1
  `;
  return rows[0] ?? {
    chat_reply_count: 0,
    tts_count: 0,
    voice_clone_count: 0,
    theater_session_count: 0
  };
}

export type AccessAndQuotaRow = {
  id: string;
  device_id: string;
  product_id: string | null;
  expires_at: string | null;
  plan: 'free' | 'monthly' | 'yearly';
  is_member: boolean;
  quota_remaining: number;
  quota_limit: number;
};

export type QuotaStatusRow = {
  id: string;
  device_id: string;
  product_id: string | null;
  expires_at: string | null;
  plan: 'free' | 'monthly' | 'yearly';
  is_member: boolean;
  chat_reply_count: number;
  tts_count: number;
  voice_clone_count: number;
  theater_session_count: number;
  voice_letter_trial_used_at: Date | null;
  theater_trial_used_at: Date | null;
};

async function ensureTTSPreviewTrialsTable() {
  await ensureQuotaSchema();
}

async function ensureFeatureTrialsTable() {
  await ensureQuotaSchema();
}

export async function hasUsedFreeTTSPreview(userId: string) {
  await ensureTTSPreviewTrialsTable();
  const rows = await sql<{ tts_preview_used_at: Date | null }[]>`
    select tts_preview_used_at
    from users
    where id = ${userId}
    limit 1
  `;
  return Boolean(rows[0]?.tts_preview_used_at);
}

export async function claimFreeTTSPreview(userId: string) {
  await ensureTTSPreviewTrialsTable();
  const rows = await sql<{ id: string }[]>`
    update users
    set tts_preview_used_at = coalesce(tts_preview_used_at, now())
    where id = ${userId}
      and tts_preview_used_at is null
    returning id
  `;
  return Boolean(rows[0]);
}

export async function refundFreeTTSPreview(userId: string) {
  await ensureTTSPreviewTrialsTable();
  await sql`
    update users
    set tts_preview_used_at = null
    where id = ${userId}
  `;
}

export async function getFeatureTrialStatus(userId: string) {
  await ensureFeatureTrialsTable();
  const rows = await sql<{
    voice_letter_trial_used_at: Date | null;
    theater_trial_used_at: Date | null;
  }[]>`
    select voice_letter_trial_used_at, theater_trial_used_at
    from users
    where id = ${userId}
    limit 1
  `;
  return {
    voiceLetterTrialUsed: Boolean(rows[0]?.voice_letter_trial_used_at),
    theaterTrialUsed: Boolean(rows[0]?.theater_trial_used_at)
  };
}

export async function claimVoiceLetterTrial(userId: string) {
  await ensureFeatureTrialsTable();
  const rows = await sql<{ id: string }[]>`
    update users
    set voice_letter_trial_used_at = coalesce(voice_letter_trial_used_at, now())
    where id = ${userId}
      and voice_letter_trial_used_at is null
    returning id
  `;
  return Boolean(rows[0]);
}

export async function refundVoiceLetterTrial(userId: string) {
  await ensureFeatureTrialsTable();
  await sql`
    update users
    set voice_letter_trial_used_at = null
    where id = ${userId}
  `;
}

export async function claimTheaterTrial(userId: string) {
  await ensureFeatureTrialsTable();
  const rows = await sql<{ id: string }[]>`
    update users
    set theater_trial_used_at = coalesce(theater_trial_used_at, now())
    where id = ${userId}
      and theater_trial_used_at is null
    returning id
  `;
  return Boolean(rows[0]);
}

export async function getOrCreateUserWithMembershipAndConsumeChatQuota(deviceId: string) {
  await ensureQuotaSchema();

  const id = crypto.randomUUID();
  const monthly = optionalEnv('AIDOL_PRODUCT_MONTHLY', 'aidol.membership.monthly');
  const yearly = optionalEnv('AIDOL_PRODUCT_YEARLY', 'aidol.membership.yearly');
  const freeLimit = chatReplyLimit(false);
  const memberLimit = chatReplyLimit(true);

  const rows = await sql<AccessAndQuotaRow[]>`
    with inserted as (
      insert into users (id, device_id)
      values (${id}, ${deviceId})
      on conflict (device_id) do nothing
      returning id, device_id
    ),
    user_row as (
      select id, device_id from inserted
      union all
      select id, device_id
      from users
      where device_id = ${deviceId}
        and not exists (select 1 from inserted)
      limit 1
    ),
    membership_row as (
      select product_id, expires_at,
        case
          when product_id = ${yearly} then 'yearly'
          when product_id = ${monthly} then 'monthly'
          else 'monthly'
        end as plan
      from subscriptions
      where user_id = (select id from user_row)
        and status = 'active'
        and (expires_at is null or expires_at > now())
      order by
        case
          when product_id = ${yearly} then 0
          when product_id = ${monthly} then 1
          else 2
        end,
        expires_at desc nulls first
      limit 1
    ),
    quota_limit as (
      select case
        when exists (select 1 from membership_row) then ${memberLimit}::int
        else ${freeLimit}::int
      end as chat_limit
    ),
    quota_row as (
      insert into daily_usage (user_id, usage_date, chat_reply_count)
      select user_row.id, current_date, 1
      from user_row
      on conflict (user_id, usage_date) do update
      set chat_reply_count = daily_usage.chat_reply_count + 1
      where daily_usage.chat_reply_count < (select chat_limit from quota_limit)
      returning chat_reply_count
    )
    select
      user_row.id,
      user_row.device_id,
      membership_row.product_id,
      membership_row.expires_at,
      coalesce(membership_row.plan, 'free') as plan,
      membership_row.product_id is not null as is_member,
      quota_row.chat_reply_count as quota_remaining,
      (select chat_limit from quota_limit) as quota_limit
    from user_row
    left join membership_row on true
    left join quota_row on true
    limit 1
  `;

  const row = rows[0];
  if (!row || row.quota_remaining == null) {
    throw new Error('Daily quota exceeded for chat.');
  }

  return row;
}

export async function getOrCreateUserQuotaStatus(deviceId: string) {
  await ensureQuotaSchema();

  const id = crypto.randomUUID();
  const monthly = optionalEnv('AIDOL_PRODUCT_MONTHLY', 'aidol.membership.monthly');
  const yearly = optionalEnv('AIDOL_PRODUCT_YEARLY', 'aidol.membership.yearly');

  const rows = await sql<QuotaStatusRow[]>`
    with inserted as (
      insert into users (id, device_id)
      values (${id}, ${deviceId})
      on conflict (device_id) do nothing
      returning id, device_id
    ),
    user_row as (
      select id, device_id from inserted
      union all
      select id, device_id
      from users
      where device_id = ${deviceId}
        and not exists (select 1 from inserted)
      limit 1
    ),
    membership_row as (
      select product_id, expires_at,
        case
          when product_id = ${yearly} then 'yearly'
          when product_id = ${monthly} then 'monthly'
          else 'monthly'
        end as plan
      from subscriptions
      where user_id = (select id from user_row)
        and status = 'active'
        and (expires_at is null or expires_at > now())
      order by
        case
          when product_id = ${yearly} then 0
          when product_id = ${monthly} then 1
          else 2
        end,
        expires_at desc nulls first
      limit 1
    ),
    usage_init as (
      insert into daily_usage (user_id, usage_date)
      select id, current_date
      from user_row
      on conflict (user_id, usage_date) do nothing
    )
    select
      user_row.id,
      user_row.device_id,
      membership_row.product_id,
      membership_row.expires_at,
      coalesce(membership_row.plan, 'free') as plan,
      membership_row.product_id is not null as is_member,
      coalesce(daily_usage.chat_reply_count, 0) as chat_reply_count,
      coalesce(daily_usage.tts_count, 0) as tts_count,
      coalesce(daily_usage.voice_clone_count, 0) as voice_clone_count,
      coalesce(daily_usage.theater_session_count, 0) as theater_session_count,
      users.voice_letter_trial_used_at,
      users.theater_trial_used_at
    from user_row
    left join membership_row on true
    left join daily_usage
      on daily_usage.user_id = user_row.id
     and daily_usage.usage_date = current_date
    left join users on users.id = user_row.id
    limit 1
  `;

  return rows[0];
}

export async function refundTheaterTrial(userId: string) {
  await ensureFeatureTrialsTable();
  await sql`
    update users
    set theater_trial_used_at = null
    where id = ${userId}
  `;
}

export async function assertAndConsumeQuota(
  userId: string,
  kind: UsageKind,
  membershipInput?: Awaited<ReturnType<typeof getMembership>>
) {
  const membership = membershipInput ?? await getMembership(userId);
  const limit = limitFor(kind, membership.limits);

  if (limit <= 0) {
    throw new Error(kind === 'chat' ? 'Daily AI reply quota is not available.' : 'This feature requires membership.');
  }

  const current = await incrementUsageCounter(userId, kind, limit);
  if (current == null) {
    if (kind === 'theater_session') {
      throw new Error('Daily theater session limit exceeded.');
    }
    throw new Error(`Daily quota exceeded for ${kind}.`);
  }

  return { remaining: Math.max(limit - current, 0), limit };
}

export async function refundConsumedQuota(userId: string, kind: UsageKind) {
  await ensureQuotaSchema();
  switch (kind) {
    case 'chat':
      await sql`
        insert into daily_usage (user_id, usage_date, chat_reply_count)
        values (${userId}, current_date, 0)
        on conflict (user_id, usage_date) do update
        set chat_reply_count = greatest(daily_usage.chat_reply_count - 1, 0)
      `;
      break;
    case 'tts':
      await sql`
        insert into daily_usage (user_id, usage_date, tts_count)
        values (${userId}, current_date, 0)
        on conflict (user_id, usage_date) do update
        set tts_count = greatest(daily_usage.tts_count - 1, 0)
      `;
      break;
    case 'theater_session':
      await sql`
        insert into daily_usage (user_id, usage_date, theater_session_count)
        values (${userId}, current_date, 0)
        on conflict (user_id, usage_date) do update
        set theater_session_count = greatest(daily_usage.theater_session_count - 1, 0)
      `;
      break;
    case 'voice_clone':
      await sql`
        insert into daily_usage (user_id, usage_date, voice_clone_count)
        values (${userId}, current_date, 0)
        on conflict (user_id, usage_date) do update
        set voice_clone_count = greatest(daily_usage.voice_clone_count - 1, 0)
      `;
      break;
  }
}

async function incrementUsageCounter(userId: string, kind: UsageKind, limit: number): Promise<number | null> {
  await ensureQuotaSchema();

  switch (kind) {
    case 'chat': {
      const rows = await sql<{ chat_reply_count: number }[]>`
        insert into daily_usage (user_id, usage_date, chat_reply_count)
        values (${userId}, current_date, 1)
        on conflict (user_id, usage_date) do update
        set chat_reply_count = daily_usage.chat_reply_count + 1
        where daily_usage.chat_reply_count < ${limit}
        returning chat_reply_count
      `;
      return rows[0]?.chat_reply_count ?? null;
    }
    case 'tts': {
      const rows = await sql<{ tts_count: number }[]>`
        insert into daily_usage (user_id, usage_date, tts_count)
        values (${userId}, current_date, 1)
        on conflict (user_id, usage_date) do update
        set tts_count = daily_usage.tts_count + 1
        where daily_usage.tts_count < ${limit}
        returning tts_count
      `;
      return rows[0]?.tts_count ?? null;
    }
    case 'theater_session': {
      const rows = await sql<{ theater_session_count: number }[]>`
        insert into daily_usage (user_id, usage_date, theater_session_count)
        values (${userId}, current_date, 1)
        on conflict (user_id, usage_date) do update
        set theater_session_count = daily_usage.theater_session_count + 1
        where daily_usage.theater_session_count < ${limit}
        returning theater_session_count
      `;
      return rows[0]?.theater_session_count ?? null;
    }
    case 'voice_clone': {
      const rows = await sql<{ voice_clone_count: number }[]>`
        insert into daily_usage (user_id, usage_date, voice_clone_count)
        values (${userId}, current_date, 1)
        on conflict (user_id, usage_date) do update
        set voice_clone_count = daily_usage.voice_clone_count + 1
        where daily_usage.voice_clone_count < ${limit}
        returning voice_clone_count
      `;
      return rows[0]?.voice_clone_count ?? null;
    }
  }
}
