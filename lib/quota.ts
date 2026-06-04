import { sql } from './db';
import { getMembership } from './membership';

export type UsageKind = 'chat' | 'tts' | 'voice_clone';

function columnFor(kind: UsageKind) {
  switch (kind) {
    case 'chat': return 'chat_reply_count';
    case 'tts': return 'tts_count';
    case 'voice_clone': return 'voice_clone_count';
  }
}

function limitFor(kind: UsageKind, limits: Awaited<ReturnType<typeof getMembership>>['limits']) {
  switch (kind) {
    case 'chat': return limits.dailyChatReplies;
    case 'tts': return limits.dailyTTS;
    case 'voice_clone': return limits.monthlyVoiceClones;
  }
}

export async function getTodayUsage(userId: string) {
  await sql`
    insert into daily_usage (user_id, usage_date)
    values (${userId}, current_date)
    on conflict (user_id, usage_date) do nothing
  `;

  const rows = await sql<{
    chat_reply_count: number;
    tts_count: number;
    voice_clone_count: number;
  }[]>`
    select chat_reply_count, tts_count, voice_clone_count
    from daily_usage
    where user_id = ${userId} and usage_date = current_date
    limit 1
  `;
  return rows[0] ?? { chat_reply_count: 0, tts_count: 0, voice_clone_count: 0 };
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
  const current = kind === 'chat' ? usage.chat_reply_count : kind === 'tts' ? usage.tts_count : usage.voice_clone_count;
  if (current >= limit) {
    throw new Error(`Daily quota exceeded for ${kind}.`);
  }

  if (col === 'chat_reply_count') {
    await sql`update daily_usage set chat_reply_count = chat_reply_count + 1 where user_id = ${userId} and usage_date = current_date`;
  } else if (col === 'tts_count') {
    await sql`update daily_usage set tts_count = tts_count + 1 where user_id = ${userId} and usage_date = current_date`;
  } else {
    await sql`update daily_usage set voice_clone_count = voice_clone_count + 1 where user_id = ${userId} and usage_date = current_date`;
  }

  return { remaining: Math.max(limit - current - 1, 0), limit };
}
