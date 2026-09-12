import { z } from 'zod';
import { fail, ok } from '@/lib/response';
import { limitsForMember } from '@/lib/membership';
import {
  commitQuota,
  getQuotaSnapshots,
  QuotaExceededError,
  releaseQuota,
  reserveQuota
} from '@/lib/quota-engine';
import {
  getCachedUserAccess,
  getOrCreateUserWithMembership,
  setCachedUserAccess
} from '@/lib/db';
import { generateChatReply, safeFallbackReply } from '@/lib/ai';
import { logIncomingRequest } from '@/lib/request-log';
import { resolvePersonaCatalogPrompt } from '@/lib/persona-catalog';

export const runtime = 'nodejs';

const BodySchema = z.object({
  profileId: z.string().optional(),
  nickname: z.string().default('Aidol'),
  persona: z.string().min(1),
  personaPresetKey: z.string().trim().min(1).optional(),
  isRealPerson: z.boolean().default(false),
  realName: z.string().default(''),
  groupName: z.string().default(''),
  mode: z.enum(['chat', 'voice_letter', 'teacher', 'theater_stage_beat', 'theater']).default('chat'),
  nativeLanguageCode: z.string().optional(),
  targetLanguageCode: z.string().optional(),
  languageLevelCode: z.string().optional(),
  studyVocabularyEntries: z.array(z.object({
    term: z.string(),
    explanation: z.string(),
    romanization: z.string().optional()
  })).optional(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string()
  })).min(1)
});

export async function POST(request: Request) {
  const requestId = request.headers.get('x-aidol-request-id')?.trim() || crypto.randomUUID();
  const startedAt = Date.now();
  let stage = 'start';
  const logStep = (nextStage: string, extra?: Record<string, unknown>) => {
    const elapsedMs = Date.now() - startedAt;
    console.log('[aidol] chat.reply', {
      requestId,
      stage: nextStage,
      elapsedMs,
      region: process.env.VERCEL_REGION ?? 'unknown',
      ...extra
    });
    stage = nextStage;
  };

  logIncomingRequest('chat.reply', request, { requestId });
  logStep('received');
  let theaterQuotaTransactionId: string | null = null;
  let theaterReplyQuotaTransactionId: string | null = null;
  let contentQuotaTransactionId: string | null = null;
  let messageQuotaTransactionId: string | null = null;
  let access: Awaited<ReturnType<typeof getOrCreateUserWithMembership>> | null = null;
  let bodyParseError: unknown = null;
  const deviceId = request.headers.get('x-aidol-device-id')?.trim();
  if (!deviceId) {
    return fail('Missing x-aidol-device-id header.', 401, 'UNAUTHORIZED');
  }
  const clientRegion = request.headers.get('x-aidol-client-region') === 'mainland'
    ? 'mainland'
    : 'overseas';
  const bodyPromise = request
    .json()
    .then((raw) => BodySchema.parse(raw))
    .catch((error) => {
      bodyParseError = error;
      return null;
    });

  try {
    const cachedAccess = getCachedUserAccess(deviceId);
    const accessPromise = bodyPromise
      .then((body) => {
        if (!body) {
          return null;
        }
        return cachedAccess ?? getOrCreateUserWithMembership(deviceId);
      })
      .catch((error) => {
        console.warn('[aidol] chat.reply access fallback', {
          requestId,
          message: error instanceof Error ? error.message : String(error)
        });
        return getOrCreateUserWithMembership(deviceId);
      });
    const [body, resolvedAccess] = await Promise.all([bodyPromise, accessPromise]);
    if (!body) {
      throw bodyParseError instanceof Error ? bodyParseError : new Error('Invalid request body.');
    }
    if (!resolvedAccess) {
      throw new Error('Unable to resolve user access.');
    }
    const userAccess = resolvedAccess;
    access = userAccess;
    setCachedUserAccess(deviceId, {
      id: userAccess.id,
      device_id: userAccess.device_id,
      product_id: userAccess.product_id,
      expires_at: userAccess.expires_at,
      plan: userAccess.plan,
      is_member: userAccess.is_member
    });
    const membership = {
      isMember: userAccess.is_member,
      productId: userAccess.product_id,
      expiresAt: userAccess.expires_at,
      plan: userAccess.plan,
      limits: limitsForMember(userAccess.is_member)
    };
    logStep('auth.ok');
    logStep('body.ok');
    logStep('membership.ok', { isMember: membership.isMember, plan: membership.plan });
    const isTheaterSessionStart = request.headers.get('x-aidol-theater-session-start') === '1';
    const isTheaterDialogue = body.mode === 'theater';
    const isVoiceLetter = body.mode === 'voice_letter';

    if (!membership.isMember) {
      if (isTheaterDialogue) {
        if (isTheaterSessionStart) {
          // The lifetime theater quota is reserved below and committed only
          // after the opening reply succeeds.
        } else {
          const quotas = await getQuotaSnapshots(userAccess.id, membership);
          const trialUsed = (quotas.find((item) => item.key === 'theater_session')?.used ?? 0) > 0;
          if (!trialUsed) {
            return fail('The theater trial has not been started.', 403, 'THEATER_TRIAL_REQUIRED');
          }
        }
      }
    }

    if (isTheaterDialogue && isTheaterSessionStart) {
      const reservation = await reserveQuota({
        userId: userAccess.id,
        key: 'theater_session',
        idempotencyKey: `${requestId}:theater-session`,
        membership,
        metadata: { mode: body.mode, profileId: body.profileId }
      });
      theaterQuotaTransactionId = reservation.transactionId;
      logStep('theater_session.quota.ok');
    }

    let quota = { remaining: 0, limit: 0 };
    try {
      if (isTheaterDialogue) {
        const theaterReplyReservation = await reserveQuota({
          userId: userAccess.id,
          key: 'theater_reply',
          idempotencyKey: `${requestId}:theater-reply`,
          membership,
          metadata: { mode: body.mode, profileId: body.profileId }
        });
        theaterReplyQuotaTransactionId = theaterReplyReservation.transactionId;
        quota = { remaining: 0, limit: 0 };
      } else {
        const sendReservation = await reserveQuota({
          userId: userAccess.id,
          key: 'message_send',
          idempotencyKey: `${requestId}:message-send`,
          membership,
          metadata: { mode: body.mode, profileId: body.profileId }
        });
        messageQuotaTransactionId = sendReservation.transactionId;
        const reservation = await reserveQuota({
          userId: userAccess.id,
          key: isVoiceLetter ? 'voice_letter' : 'chat_reply',
          idempotencyKey: `${requestId}:content`,
          membership,
          metadata: { mode: body.mode, profileId: body.profileId }
        });
        contentQuotaTransactionId = reservation.transactionId;
        quota = { remaining: 0, limit: reservation.limit };
      }
      logStep('chat.quota.ok', { remaining: quota.remaining, limit: quota.limit });
    } catch (error) {
      if (theaterQuotaTransactionId) {
        await releaseQuota(theaterQuotaTransactionId).catch(() => {});
        theaterQuotaTransactionId = null;
      }
      throw error;
    }

    try {
      let resolvedPersona = body.persona;
      let resolvedGroupName = body.groupName;
      let isCatalogPersona = false;
      if (body.personaPresetKey) {
        try {
          const catalogPersona = await resolvePersonaCatalogPrompt(body.personaPresetKey);
          if (catalogPersona) {
            resolvedPersona = catalogPersona.persona;
            resolvedGroupName = catalogPersona.group;
            isCatalogPersona = true;
          }
        } catch (error) {
          console.warn('[aidol] chat.reply persona catalog fallback', {
            requestId,
            personaKey: body.personaPresetKey,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      const reply = await generateChatReply({
        nickname: body.nickname,
        persona: resolvedPersona,
        isCatalogPersona,
        isRealPerson: body.isRealPerson,
        realName: body.realName,
        groupName: resolvedGroupName,
        mode: body.mode,
        messages: body.messages,
        nativeLanguageCode: body.nativeLanguageCode,
        targetLanguageCode: body.targetLanguageCode,
        languageLevelCode: body.languageLevelCode,
        studyVocabularyEntries: body.studyVocabularyEntries,
        region: clientRegion
      });

      if (request.signal.aborted) throw new Error('Request was canceled before completion.');
      if (contentQuotaTransactionId) await commitQuota(contentQuotaTransactionId);
      if (messageQuotaTransactionId) await commitQuota(messageQuotaTransactionId);
      if (theaterQuotaTransactionId) await commitQuota(theaterQuotaTransactionId);
      if (theaterReplyQuotaTransactionId) await commitQuota(theaterReplyQuotaTransactionId);
      logStep('model.ok', { replyChars: reply.reply.length });

      logStep('success', { totalMs: Date.now() - startedAt });
      return ok({ reply, quota });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canUseSafeFallback =
        message.includes('empty content') ||
        message.includes('invalid envelope') ||
        message.includes('non-JSON content') ||
        message.includes('timed out') ||
        message.includes('HTTP 401') ||
        message.includes('HTTP 408') ||
        message.includes('HTTP 409') ||
        message.includes('HTTP 429') ||
        /HTTP 5\d\d/.test(message);
      if (canUseSafeFallback) {
        if (contentQuotaTransactionId) await commitQuota(contentQuotaTransactionId).catch(() => {});
        if (messageQuotaTransactionId) await commitQuota(messageQuotaTransactionId).catch(() => {});
        if (theaterQuotaTransactionId) await commitQuota(theaterQuotaTransactionId).catch(() => {});
        if (theaterReplyQuotaTransactionId) await commitQuota(theaterReplyQuotaTransactionId).catch(() => {});
        console.warn('[aidol] chat.reply using safe fallback', { requestId, stage, message });
        logStep('fallback.ok');
        return ok({
          reply: safeFallbackReply(body.targetLanguageCode, body.nativeLanguageCode, body.mode),
          quota
        });
      }
      if (contentQuotaTransactionId) await releaseQuota(contentQuotaTransactionId).catch(() => {});
      if (messageQuotaTransactionId) await releaseQuota(messageQuotaTransactionId).catch(() => {});
      if (theaterQuotaTransactionId) await releaseQuota(theaterQuotaTransactionId).catch(() => {});
      if (theaterReplyQuotaTransactionId) await releaseQuota(theaterReplyQuotaTransactionId).catch(() => {});
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[aidol] chat.reply failed', {
      requestId,
      stage,
      elapsedMs: Date.now() - startedAt,
      message
    });
    if (message.includes('Daily theater session limit exceeded')) {
      return fail('今日小剧场次数已用完，请明天再试。', 403, 'THEATER_DAILY_LIMIT');
    }
    if (error instanceof QuotaExceededError) {
      const code = error.key === 'voice_letter'
        ? 'VOICE_LETTER_LIMIT'
        : error.key === 'message_send'
          ? 'MESSAGE_SEND_LIMIT'
        : error.key === 'theater_session'
          ? 'THEATER_DAILY_LIMIT'
          : error.key === 'theater_reply'
            ? 'THEATER_REPLY_LIMIT'
          : 'CHAT_QUOTA_EXCEEDED';
      return fail(message, 403, code);
    }
    return fail(message, 500, 'CHAT_REPLY_FAILED');
  }
}
