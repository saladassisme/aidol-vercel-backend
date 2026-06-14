import { z } from 'zod';
import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { assertAndConsumeQuota, claimFreeTTSPreview, refundFreeTTSPreview } from '@/lib/quota';
import { synthesizeWithDashScope } from '@/lib/dashscope';
import { sha256Hex } from '@/lib/hash';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

const BodySchema = z.object({
  text: z.string().min(1).max(1000),
  voiceId: z.string().min(1),
  model: z.string().optional(),
  languageType: z.string().optional()
});

export async function POST(request: Request) {
  let claimedTrial = false;
  let userId: string | null = null;
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;
    userId = auth.userId;

    const body = BodySchema.parse(await request.json());
    const isTrial = request.headers.get('x-aidol-trial') === 'onboarding';

    const model = body.model || process.env.DASHSCOPE_TTS_VC_MODEL || 'qwen3-tts-vc-2026-01-22';
    const languageType = body.languageType || 'Korean';
    const textHash = await sha256Hex(`${body.voiceId}\n${model}\n${languageType}\n${body.text}`);

    const cached = await sql<{ audio_url: string; audio_base64: string | null }[]>`
      select audio_url, audio_base64 from tts_cache
      where user_id = ${auth.userId}
        and voice_id = ${body.voiceId}
        and model = ${model}
        and text_hash = ${textHash}
      limit 1
    `;

    if (cached[0]) {
      let audioBase64 = cached[0].audio_base64;
      if (!audioBase64) {
        const downloaded = await fetchAudioAsBase64(cached[0].audio_url);
        audioBase64 = downloaded.audioBase64;
        await sql`
          update tts_cache
          set audio_base64 = ${audioBase64}
          where user_id = ${auth.userId}
            and voice_id = ${body.voiceId}
            and model = ${model}
            and text_hash = ${textHash}
        `;
      }
      return ok({ audioUrl: cached[0].audio_url, audioBase64, cached: true });
    }

    if (isTrial) {
      claimedTrial = await claimFreeTTSPreview(auth.userId);
      if (!claimedTrial) return fail('免费试听已用完，请开通会员后继续。', 403, 'MEMBERSHIP_REQUIRED');
    } else {
      await assertAndConsumeQuota(auth.userId, 'tts');
    }

    const synthesized = await synthesizeWithDashScope({ text: body.text, voiceId: body.voiceId, model, languageType });
    const downloaded = await fetchAudioAsBase64(synthesized.audioURL);

    await sql`
      insert into tts_cache (id, user_id, voice_id, model, text_hash, audio_url, audio_base64)
      values (${crypto.randomUUID()}, ${auth.userId}, ${body.voiceId}, ${model}, ${textHash}, ${synthesized.audioURL}, ${downloaded.audioBase64})
      on conflict (user_id, voice_id, model, text_hash) do update set
        audio_url = excluded.audio_url,
        audio_base64 = excluded.audio_base64
    `;

    return ok({ audioUrl: synthesized.audioURL, audioBase64: downloaded.audioBase64, cached: false });
  } catch (error) {
    if (claimedTrial && userId) {
      try {
        await refundFreeTTSPreview(userId);
      } catch {
        // Ignore refund failures; the user can retry from the preview flow.
      }
    }
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'TTS_SYNTHESIZE_FAILED');
  }
}

async function fetchAudioAsBase64(audioUrl: string) {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`音频下载失败：HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (!bytes.length) {
    throw new Error('音频下载失败：空文件');
  }
  return { audioBase64: bytes.toString('base64') };
}
