import { z } from 'zod';
import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { getMembership } from '@/lib/membership';
import { assertAndConsumeQuota } from '@/lib/quota';
import { synthesizeWithDashScope } from '@/lib/dashscope';
import { sha256Hex } from '@/lib/hash';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

const BodySchema = z.object({
  text: z.string().min(1).max(1000),
  voiceId: z.string().min(1),
  model: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const membership = await getMembership(auth.userId);
    if (!membership.limits.voiceEnabled) return fail('TTS requires membership.', 403, 'MEMBERSHIP_REQUIRED');

    const body = BodySchema.parse(await request.json());
    const model = body.model || process.env.DASHSCOPE_TTS_VC_MODEL || 'qwen3-tts-vc-2026-01-22';
    const textHash = await sha256Hex(`${body.voiceId}\n${model}\n${body.text}`);

    const cached = await sql<{ audio_url: string }[]>`
      select audio_url from tts_cache
      where user_id = ${auth.userId}
        and voice_id = ${body.voiceId}
        and model = ${model}
        and text_hash = ${textHash}
      limit 1
    `;

    if (cached[0]) {
      return ok({ audioUrl: cached[0].audio_url, cached: true });
    }

    await assertAndConsumeQuota(auth.userId, 'tts');
    const synthesized = await synthesizeWithDashScope({ text: body.text, voiceId: body.voiceId, model });

    await sql`
      insert into tts_cache (id, user_id, voice_id, model, text_hash, audio_url)
      values (${crypto.randomUUID()}, ${auth.userId}, ${body.voiceId}, ${model}, ${textHash}, ${synthesized.audioURL})
      on conflict (user_id, voice_id, model, text_hash) do update set audio_url = excluded.audio_url
    `;

    return ok({ audioUrl: synthesized.audioURL, cached: false });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'TTS_SYNTHESIZE_FAILED');
  }
}
