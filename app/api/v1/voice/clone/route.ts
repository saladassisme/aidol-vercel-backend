import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { cloneVoiceWithDashScope } from '@/lib/dashscope';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  try {
    console.log(`[voice.clone] ${requestId} start`);
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const form = await request.formData();
    const file = form.get('audio');
    if (!(file instanceof File)) return fail('audio file is required.', 400, 'MISSING_AUDIO');
    if (file.size > 10 * 1024 * 1024) return fail('audio file must be <= 10MB.', 400, 'AUDIO_TOO_LARGE');

    const preferredName = String(form.get('preferredName') || 'aidol_voice');
    console.log(`[voice.clone] ${requestId} received file name=${file.name || 'unknown'} type=${file.type || 'unknown'} size=${file.size} preferredName=${preferredName}`);
    const arrayBuffer = await file.arrayBuffer();

    console.log(`[voice.clone] ${requestId} dashscope clone start`);
    const cloned = await cloneVoiceWithDashScope({
      audioData: Buffer.from(arrayBuffer),
      mimeType: file.type || 'audio/wav',
      preferredName
    });
    console.log(`[voice.clone] ${requestId} dashscope clone success voiceId=${cloned.voiceId}`);

    const id = crypto.randomUUID();
    await sql`
      insert into voices (id, user_id, provider, model, voice_id, display_name)
      values (${id}, ${auth.userId}, ${cloned.provider}, ${cloned.model}, ${cloned.voiceId}, ${preferredName})
    `;

    console.log(`[voice.clone] ${requestId} success durationMs=${Date.now() - startedAt}`);
    return ok({ id, voiceId: cloned.voiceId, provider: cloned.provider, model: cloned.model, displayName: preferredName });
  } catch (error) {
    console.error(`[voice.clone] ${requestId} failed durationMs=${Date.now() - startedAt}`, error);
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'VOICE_CLONE_FAILED');
  }
}
