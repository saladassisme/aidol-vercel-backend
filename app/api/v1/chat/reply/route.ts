import { z } from 'zod';
import { fail, ok } from '@/lib/response';
import { limitsForMember } from '@/lib/membership';
import {
  assertAndConsumeQuota,
  claimTheaterTrial,
  claimVoiceLetterTrial,
  getOrCreateUserWithMembershipAndConsumeChatQuota,
  getOrCreateUserQuotaStatus,
  refundConsumedQuota,
  refundTheaterTrial,
  refundVoiceLetterTrial
} from '@/lib/quota';
import {
  getCachedUserAccess,
  getOrCreateUserWithMembership,
  setCachedUserAccess
} from '@/lib/db';
import { generateChatReply } from '@/lib/ai';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

type ChatAccessWithQuota = Awaited<ReturnType<typeof getOrCreateUserWithMembershipAndConsumeChatQuota>>;

function hasChatQuota(
  access: Awaited<ReturnType<typeof getOrCreateUserWithMembership>> | ChatAccessWithQuota | null
): access is ChatAccessWithQuota {
  return Boolean(access && 'quota_remaining' in access && 'quota_limit' in access);
}

const BodySchema = z.object({
  profileId: z.string().optional(),
  nickname: z.string().default('Aidol'),
  persona: z.string().min(1),
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
  let consumedTheaterSession = false;
  let access: Awaited<ReturnType<typeof getOrCreateUserWithMembership>> | null = null;
  let bodyParseError: unknown = null;
  const deviceId = request.headers.get('x-aidol-device-id')?.trim();
  if (!deviceId) {
    return fail('Missing x-aidol-device-id header.', 401, 'UNAUTHORIZED');
  }
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
        if (body.mode === 'chat' && cachedAccess) {
          return cachedAccess;
        }
        if (body.mode === 'chat') {
          return getOrCreateUserWithMembershipAndConsumeChatQuota(deviceId);
        }
        if (body.mode === 'voice_letter' || body.mode === 'theater' || body.mode === 'theater_stage_beat') {
          return getOrCreateUserQuotaStatus(deviceId);
        }
        return getOrCreateUserWithMembership(deviceId);
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

    let claimedTrial: 'theater' | 'voice_letter' | null = null;
    if (!membership.isMember) {
      if (isTheaterDialogue) {
        if (isTheaterSessionStart) {
          if ('theater_trial_used_at' in resolvedAccess && resolvedAccess.theater_trial_used_at) {
            return fail('The theater trial has been used. Membership is required.', 403, 'THEATER_TRIAL_USED');
          }
          const okClaim = await claimTheaterTrial(userAccess.id);
          if (!okClaim) {
            return fail('The theater trial has been used. Membership is required.', 403, 'THEATER_TRIAL_USED');
          }
          claimedTrial = 'theater';
        } else {
          if (!('theater_trial_used_at' in resolvedAccess) || !resolvedAccess.theater_trial_used_at) {
            return fail('The theater trial has not been started.', 403, 'THEATER_TRIAL_REQUIRED');
          }
        }
      }
      if (isVoiceLetter) {
        if ('voice_letter_trial_used_at' in resolvedAccess && resolvedAccess.voice_letter_trial_used_at) {
          return fail('The voice letter trial has been used. Membership is required.', 403, 'VOICE_LETTER_TRIAL_USED');
        }
        const okClaim = await claimVoiceLetterTrial(userAccess.id);
        if (!okClaim) {
          return fail('The voice letter trial has been used. Membership is required.', 403, 'VOICE_LETTER_TRIAL_USED');
        }
        claimedTrial = 'voice_letter';
      }
    } else if (isTheaterDialogue && isTheaterSessionStart) {
      await assertAndConsumeQuota(userAccess.id, 'theater_session', membership);
      consumedTheaterSession = true;
      logStep('theater_session.quota.ok');
    }

    let quota;
    try {
      if (!isTheaterDialogue && !isVoiceLetter && hasChatQuota(resolvedAccess)) {
        quota = {
          remaining: resolvedAccess.quota_remaining,
          limit: resolvedAccess.quota_limit
        };
      } else {
        quota = await assertAndConsumeQuota(userAccess.id, 'chat', membership);
      }
      logStep('chat.quota.ok', { remaining: quota.remaining, limit: quota.limit });
    } catch (error) {
      if (consumedTheaterSession) {
        await refundConsumedQuota(userAccess.id, 'theater_session').catch(() => {});
      }
      throw error;
    }

    try {
      const reply = await generateChatReply({
        nickname: body.nickname,
        persona: body.persona,
        isRealPerson: body.isRealPerson,
        realName: body.realName,
        groupName: body.groupName,
        mode: body.mode,
        messages: body.messages,
        nativeLanguageCode: body.nativeLanguageCode,
        targetLanguageCode: body.targetLanguageCode,
        languageLevelCode: body.languageLevelCode,
        studyVocabularyEntries: body.studyVocabularyEntries
      });
      logStep('model.ok', { replyChars: reply.reply.length });

      logStep('success', { totalMs: Date.now() - startedAt });
      return ok({ reply, quota });
    } catch (error) {
      if (claimedTrial === 'theater') {
        await refundTheaterTrial(userAccess.id).catch(() => {});
      } else if (claimedTrial === 'voice_letter') {
        await refundVoiceLetterTrial(userAccess.id).catch(() => {});
      }
      if (consumedTheaterSession) {
        await refundConsumedQuota(userAccess.id, 'theater_session').catch(() => {});
      }
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
    return fail(message, 500, 'CHAT_REPLY_FAILED');
  }
}
