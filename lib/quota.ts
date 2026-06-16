import { sql } from './db';
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

async function ensureTheaterUsageColumn() {
  await sql`
    alter table daily_usage
    add column if not exists theater_session_count int not null default 0
  `;
}

export async function getTodayUsage(userId: string) {
  await ensureTheaterUsageColumn();
  await sql`
    insert into daily_usage (user_id, usage_date)
    values (${userId}, current_date)
    on conflict (user_id, usage_date) do nothing
  `;

  const rows = await sql<{
    chat_reply_count: number;
    tts_count: number;
    voice_clone_count: number;
    theater_session_count: number;
  }[]>`
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

async function ensureTTSPreviewTrialsTable() {
  await sql`
    alter table users
    add column if not exists tts_preview_used_at timestamptz
  `;
}

async function ensureFeatureTrialsTable() {
  await sql`
    alter table users
    add column if not exists voice_letter_trial_used_at timestamptz,
    add column if not exists theater_trial_used_at timestamptz
  `;
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

export async function refundTheaterTrial(userId: string) {
  await ensureFeatureTrialsTable();
  await sql`
    update users
    set theater_trial_used_at = null
    where id = ${userId}
  `;
}

export async function assertAndConsumeQuota(userId: string, kind: UsageKind) {
  const membership = await getMembership(userId);
  const limit = limitFor(kind, membership.limits);
  const col = columnFor(kind);

  if (limit <= 0) {
    throw new Error(kind === 'chat' ? 'Daily AI reply quota is not available.' : 'This feature requires membership.');
  }

  await sql`
    insert into daily_usage (user_id, usage_date)
    values (${userId}, current_date)
    on conflict (user_id, usage_date) do nothing
  `;

  const usage = await getTodayUsage(userId);
  const current = kind === 'chat'
    ? usage.chat_reply_count
    : kind === 'tts'
      ? usage.tts_count
      : kind === 'theater_session'
        ? usage.theater_session_count
        : usage.voice_clone_count;
  if (current >= limit) {
    if (kind === 'theater_session') {
      throw new Error('Daily theater session limit exceeded.');
    }
    throw new Error(`Daily quota exceeded for ${kind}.`);
  }

  if (col === 'chat_reply_count') {
    await sql`update daily_usage set chat_reply_count = chat_reply_count + 1 where user_id = ${userId} and usage_date = current_date`;
  } else if (col === 'tts_count') {
    await sql`update daily_usage set tts_count = tts_count + 1 where user_id = ${userId} and usage_date = current_date`;
  } else if (col === 'theater_session_count') {
    await sql`update daily_usage set theater_session_count = theater_session_count + 1 where user_id = ${userId} and usage_date = current_date`;
  } else {
    await sql`update daily_usage set voice_clone_count = voice_clone_count + 1 where user_id = ${userId} and usage_date = current_date`;
  }

  return { remaining: Math.max(limit - current - 1, 0), limit };
}

export async function refundConsumedQuota(userId: string, kind: UsageKind) {
  await sql`
    insert into daily_usage (user_id, usage_date)
    values (${userId}, current_date)
    on conflict (user_id, usage_date) do nothing
  `;

  const col = columnFor(kind);
  if (col === 'chat_reply_count') {
    await sql`
      update daily_usage
      set chat_reply_count = greatest(chat_reply_count - 1, 0)
      where user_id = ${userId} and usage_date = current_date
    `;
  } else if (col === 'tts_count') {
    await sql`
      update daily_usage
      set tts_count = greatest(tts_count - 1, 0)
      where user_id = ${userId} and usage_date = current_date
    `;
  } else if (col === 'theater_session_count') {
    await sql`
      update daily_usage
      set theater_session_count = greatest(theater_session_count - 1, 0)
      where user_id = ${userId} and usage_date = current_date
    `;
  } else {
    await sql`
      update daily_usage
      set voice_clone_count = greatest(voice_clone_count - 1, 0)
      where user_id = ${userId} and usage_date = current_date
    `;
  }
}
