import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { cloneVoiceWithDashScope } from '@/lib/dashscope';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const form = await request.formData();
    const file = form.get('audio');
    if (!(file instanceof File)) return fail('audio file is required.', 400, 'MISSING_AUDIO');
    if (file.size > 10 * 1024 * 1024) return fail('audio file must be <= 10MB.', 400, 'AUDIO_TOO_LARGE');

    const preferredName = String(form.get('preferredName') || 'aidol_voice');
    const arrayBuffer = await file.arrayBuffer();

    const cloned = await cloneVoiceWithDashScope({
      audioData: Buffer.from(arrayBuffer),
      mimeType: file.type || 'audio/wav',
      preferredName
    });

    const id = crypto.randomUUID();
    await sql`
      insert into voices (id, user_id, provider, model, voice_id, display_name)
      values (${id}, ${auth.userId}, ${cloned.provider}, ${cloned.model}, ${cloned.voiceId}, ${preferredName})
    `;

    return ok({ id, voiceId: cloned.voiceId, provider: cloned.provider, model: cloned.model, displayName: preferredName });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'VOICE_CLONE_FAILED');
  }
}
