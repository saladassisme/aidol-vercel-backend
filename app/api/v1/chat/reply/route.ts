import { z } from 'zod';
import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import {
  assertAndConsumeQuota,
  claimTheaterTrial,
  claimVoiceLetterTrial,
  getFeatureTrialStatus,
  refundConsumedQuota,
  refundTheaterTrial,
  refundVoiceLetterTrial
} from '@/lib/quota';
import { getMembership } from '@/lib/membership';
import { generateChatReply } from '@/lib/ai';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

const BodySchema = z.object({
  profileId: z.string().optional(),
  nickname: z.string().default('Aidol'),
  persona: z.string().min(1),
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
  logIncomingRequest('chat.reply', request);
  let consumedTheaterSession = false;
  let userId: string | null = null;

  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;
    userId = auth.userId;

    const body = BodySchema.parse(await request.json());
    const membership = await getMembership(auth.userId);
    const isTheaterSessionStart = request.headers.get('x-aidol-theater-session-start') === '1';
    const isTheaterDialogue = body.mode === 'theater';

    let claimedTrial: 'theater' | 'voice_letter' | null = null;
    if (!membership.isMember) {
      if (isTheaterDialogue) {
        if (isTheaterSessionStart) {
          const okClaim = await claimTheaterTrial(auth.userId);
          if (!okClaim) {
            return fail('The theater trial has been used. Membership is required.', 403, 'THEATER_TRIAL_USED');
          }
          claimedTrial = 'theater';
        } else {
          const trials = await getFeatureTrialStatus(auth.userId);
          if (!trials.theaterTrialUsed) {
            return fail('The theater trial has not been started.', 403, 'THEATER_TRIAL_REQUIRED');
          }
        }
      }
      if (body.mode === 'voice_letter') {
        const okClaim = await claimVoiceLetterTrial(auth.userId);
        if (!okClaim) {
          return fail('The voice letter trial has been used. Membership is required.', 403, 'VOICE_LETTER_TRIAL_USED');
        }
        claimedTrial = 'voice_letter';
      }
    } else if (isTheaterDialogue && isTheaterSessionStart) {
      await assertAndConsumeQuota(auth.userId, 'theater_session');
      consumedTheaterSession = true;
    }

    let quota;
    try {
      quota = await assertAndConsumeQuota(auth.userId, 'chat');
    } catch (error) {
      if (consumedTheaterSession && userId) {
        await refundConsumedQuota(userId, 'theater_session').catch(() => {});
      }
      throw error;
    }

    try {
      const reply = await generateChatReply({
        nickname: body.nickname,
        persona: body.persona,
        mode: body.mode,
        messages: body.messages,
        nativeLanguageCode: body.nativeLanguageCode,
        targetLanguageCode: body.targetLanguageCode,
        languageLevelCode: body.languageLevelCode,
        studyVocabularyEntries: body.studyVocabularyEntries
      });

      return ok({ reply, quota });
    } catch (error) {
      if (claimedTrial === 'theater') {
        await refundTheaterTrial(auth.userId).catch(() => {});
      } else if (claimedTrial === 'voice_letter') {
        await refundVoiceLetterTrial(auth.userId).catch(() => {});
      }
      if (consumedTheaterSession) {
        await refundConsumedQuota(auth.userId, 'theater_session').catch(() => {});
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('Daily theater session limit exceeded')) {
      return fail('今日小剧场次数已用完，请明天再试。', 403, 'THEATER_DAILY_LIMIT');
    }
    return fail(message, 500, 'CHAT_REPLY_FAILED');
  }
}
