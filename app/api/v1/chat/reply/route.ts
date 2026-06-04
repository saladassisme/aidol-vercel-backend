import { z } from 'zod';
import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { assertAndConsumeQuota } from '@/lib/quota';
import { generateChatReply } from '@/lib/ai';

export const runtime = 'nodejs';

const BodySchema = z.object({
  profileId: z.string().optional(),
  nickname: z.string().default('Aidol'),
  persona: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string()
  })).min(1)
});

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const body = BodySchema.parse(await request.json());
    const quota = await assertAndConsumeQuota(auth.userId, 'chat');
    const reply = await generateChatReply({ nickname: body.nickname, persona: body.persona, messages: body.messages });

    return ok({ reply, quota });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'CHAT_REPLY_FAILED');
  }
}
