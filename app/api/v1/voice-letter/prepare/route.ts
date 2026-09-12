import { z } from 'zod';
import { generateChatReply } from '@/lib/ai';
import { isResponse, requireAuth } from '@/lib/auth';
import { downloadDashScopeAudio, synthesizeWithDashScope } from '@/lib/dashscope';
import { sql } from '@/lib/db';
import { getMembership } from '@/lib/membership';
import { resolvePersonaCatalogPrompt } from '@/lib/persona-catalog';
import { commitQuota, getQuotaSnapshots, QuotaExceededError, releaseQuota, reserveQuota } from '@/lib/quota-engine';
import { fail, ok } from '@/lib/response';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';
export const maxDuration = 120;

const BodySchema = z.object({
  profileId: z.string().min(1),
  nickname: z.string().default('Aidol'),
  persona: z.string().min(1),
  personaPresetKey: z.string().trim().min(1).optional(),
  voiceId: z.string().trim().min(1),
  languageType: z.string().optional(),
  nativeLanguageCode: z.string().optional(),
  targetLanguageCode: z.string().optional(),
  languageLevelCode: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string()
  })).default([])
});

type VoiceLetterRow = {
  id: string;
  quota_transaction_id: string | null;
  profile_id: string;
  status: 'preparing' | 'succeeded' | 'failed';
  reply_payload: unknown | null;
  audio_url: string | null;
  audio_base64: string | null;
  updated_at: string;
};

async function voiceLetterForPeriod(userId: string, periodKey: string) {
  const rows = await sql<VoiceLetterRow[]>`
    select id, quota_transaction_id, profile_id, status, reply_payload, audio_url, audio_base64, updated_at
    from voice_letters
    where user_id = ${userId} and quota_period_key = ${periodKey}
    limit 1
  `;
  return rows[0] ?? null;
}

function cachedResponse(row: VoiceLetterRow) {
  return ok({
    profileId: row.profile_id,
    reply: row.reply_payload,
    audioUrl: row.audio_url,
    audioBase64: row.audio_base64,
    cached: true
  });
}

export async function POST(request: Request) {
  logIncomingRequest('voice-letter.prepare', request);
  const requestId = request.headers.get('x-aidol-request-id')?.trim() || crypto.randomUUID();
  let recordId: string | null = null;
  let quotaTransactionId: string | null = null;

  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;
    const body = BodySchema.parse(await request.json());
    const clientRegion = request.headers.get('x-aidol-client-region') === 'mainland' ? 'mainland' : 'overseas';
    const membership = await getMembership(auth.userId);
    const snapshot = (await getQuotaSnapshots(auth.userId, membership)).find((item) => item.key === 'voice_letter');
    if (!snapshot) throw new Error('Voice letter quota policy is unavailable.');

    const existing = await voiceLetterForPeriod(auth.userId, snapshot.periodKey);
    if (existing?.status === 'succeeded') {
      if (existing.profile_id !== body.profileId) {
        return fail('Today\'s voice letter has already been created for another Aidol.', 403, 'VOICE_LETTER_LIMIT');
      }
      return cachedResponse(existing);
    }
    if (existing?.status === 'preparing') {
      const ageMs = Date.now() - new Date(existing.updated_at).getTime();
      if (ageMs < 5 * 60 * 1000) {
        return fail('Today\'s voice letter is still being prepared.', 409, 'VOICE_LETTER_PREPARING');
      }
      if (existing.quota_transaction_id) await releaseQuota(existing.quota_transaction_id);
      await sql`update voice_letters set status = 'failed', error_message = 'stale preparation recovered', updated_at = now() where id = ${existing.id}`;
    }

    const reservation = await reserveQuota({
      userId: auth.userId,
      key: 'voice_letter',
      idempotencyKey: `${requestId}:voice-letter`,
      membership,
      metadata: { profileId: body.profileId }
    });
    quotaTransactionId = reservation.transactionId;
    recordId = existing?.id ?? crypto.randomUUID();

    const prepared = await sql<VoiceLetterRow[]>`
      insert into voice_letters (
        id, user_id, quota_transaction_id, quota_period_key, profile_id, request_key, status, updated_at
      ) values (
        ${recordId}, ${auth.userId}, ${quotaTransactionId}, ${reservation.periodKey},
        ${body.profileId}, ${requestId}, 'preparing', now()
      )
      on conflict (user_id, quota_period_key) do update set
        quota_transaction_id = excluded.quota_transaction_id,
        profile_id = excluded.profile_id,
        request_key = excluded.request_key,
        status = 'preparing',
        reply_payload = null,
        audio_url = null,
        audio_base64 = null,
        error_message = null,
        updated_at = now()
      where voice_letters.status = 'failed'
      returning id, quota_transaction_id, profile_id, status, reply_payload, audio_url, audio_base64
    `;
    if (!prepared[0]) {
      await releaseQuota(quotaTransactionId);
      quotaTransactionId = null;
      return fail('Today\'s voice letter is unavailable.', 409, 'VOICE_LETTER_UNAVAILABLE');
    }

    let persona = body.persona;
    let groupName = '';
    let isCatalogPersona = false;
    if (body.personaPresetKey) {
      const catalog = await resolvePersonaCatalogPrompt(body.personaPresetKey).catch(() => null);
      if (catalog) {
        persona = catalog.persona;
        groupName = catalog.group;
        isCatalogPersona = true;
      }
    }

    const region = request.headers.get('x-aidol-client-region') === 'mainland' ? 'mainland' : 'overseas';
    const reply = await generateChatReply({
      nickname: body.nickname,
      persona,
      isCatalogPersona,
      isRealPerson: false,
      realName: '',
      groupName,
      mode: 'voice_letter',
      messages: body.messages,
      nativeLanguageCode: body.nativeLanguageCode,
      targetLanguageCode: body.targetLanguageCode,
      languageLevelCode: body.languageLevelCode,
      region
    });
    const speechText = reply.reply.trim().slice(0, 980);
    if (!speechText) throw new Error('Voice letter generation returned empty content.');

    let resolvedVoiceId = body.voiceId;
    if (resolvedVoiceId.startsWith('preset:') && body.personaPresetKey) {
      const voiceRows = await sql<{ voice_id: string | null; voice_id_mainland: string | null; voice_id_overseas: string | null }[]>`
        select voice_id, voice_id_mainland, voice_id_overseas
        from persona_catalog_configs where persona_key = ${body.personaPresetKey} limit 1
      `;
      const row = voiceRows[0];
      resolvedVoiceId = (clientRegion === 'mainland' ? row?.voice_id_mainland : row?.voice_id_overseas) || row?.voice_id || '';
      if (!resolvedVoiceId) throw new Error('Preset voice is not configured for this region.');
    }
    const synthesized = await synthesizeWithDashScope({
      text: speechText,
      voiceId: resolvedVoiceId,
      languageType: body.languageType,
      region
    });
    const downloaded = await downloadDashScopeAudio(synthesized.audioURL);
    const audioBase64 = downloaded.audioBase64;

    const completed = await sql<VoiceLetterRow[]>`
      update voice_letters
      set status = 'succeeded', reply_payload = ${sql.json(reply)},
          audio_url = ${synthesized.audioURL}, audio_base64 = ${audioBase64},
          error_message = null, updated_at = now()
      where id = ${recordId} and quota_transaction_id = ${quotaTransactionId}
      returning id, quota_transaction_id, profile_id, status, reply_payload, audio_url, audio_base64
    `;
    if (!completed[0]) throw new Error('Voice letter could not be persisted.');

    await commitQuota(quotaTransactionId);
    return ok({ profileId: body.profileId, reply, audioUrl: synthesized.audioURL, audioBase64, cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (recordId && quotaTransactionId) {
      await sql`
        update voice_letters
        set status = 'failed', error_message = ${message}, updated_at = now()
        where id = ${recordId} and quota_transaction_id = ${quotaTransactionId}
      `.catch(() => {});
    }
    if (quotaTransactionId) await releaseQuota(quotaTransactionId).catch(() => {});
    if (error instanceof QuotaExceededError) {
      return fail('Voice letter quota has been used.', 403, 'VOICE_LETTER_LIMIT');
    }
    return fail(message, 500, 'VOICE_LETTER_PREPARE_FAILED');
  }
}
