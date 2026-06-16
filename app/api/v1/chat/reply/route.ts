import { z } from 'zod';
import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { assertAndConsumeQuota, claimTheaterTrial, claimVoiceLetterTrial, refundTheaterTrial, refundVoiceLetterTrial } from '@/lib/quota';
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
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = BodySchema.parse(await request.json());
    const membership = await getMembership(auth.userId);

    // One-time free trials: theater + voice letter (lifetime per backend user).
    // If a free user already used the trial, hard-block.
    let claimedTrial: 'theater' | 'voice_letter' | null = null;
    if (!membership.isMember) {
      if (body.mode === 'theater' || body.mode === 'theater_stage_beat') {
        const okClaim = await claimTheaterTrial(auth.userId);
        if (!okClaim) return fail('The theater trial has been used. Membership is required.', 403, 'THEATER_TRIAL_USED');
        claimedTrial = 'theater';
      }
      if (body.mode === 'voice_letter') {
        const okClaim = await claimVoiceLetterTrial(auth.userId);
        if (!okClaim) return fail('The voice letter trial has been used. Membership is required.', 403, 'VOICE_LETTER_TRIAL_USED');
        claimedTrial = 'voice_letter';
      }
    }

    const quota = await assertAndConsumeQuota(auth.userId, 'chat');
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
      // If trial was claimed but generation failed, rollback the trial flag so the user doesn't lose their one-time try.
      if (claimedTrial === 'theater') {
        await refundTheaterTrial(auth.userId).catch(() => {});
      } else if (claimedTrial === 'voice_letter') {
        await refundVoiceLetterTrial(auth.userId).catch(() => {});
      }
      throw error;
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'CHAT_REPLY_FAILED');
  }
}
