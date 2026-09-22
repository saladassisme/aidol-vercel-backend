import { sql } from '@/lib/db';
import { requireAuth, isResponse } from '@/lib/auth';
import { fail, ok } from '@/lib/response';

export const runtime = 'nodejs';

async function ownedGroup(groupID: string, userID: string) {
  const rows = await sql`select id from group_chats where id = ${groupID} and user_id = ${userID}`;
  return Boolean(rows[0]);
}

export async function GET(request: Request, context: { params: Promise<{ groupID: string }> }) {
  const auth = await requireAuth(request); if (isResponse(auth)) return auth;
  const { groupID } = await context.params;
  if (!await ownedGroup(groupID, auth.userId)) return fail('Group chat not found.', 404, 'NOT_FOUND');
  const rows = await sql`select id, sender_type, sender_profile_id, content_type, content, created_at from group_chat_messages where group_chat_id = ${groupID} order by created_at asc`;
  return ok(rows);
}

export async function POST(request: Request, context: { params: Promise<{ groupID: string }> }) {
  const auth = await requireAuth(request); if (isResponse(auth)) return auth;
  const { groupID } = await context.params;
  if (!await ownedGroup(groupID, auth.userId)) return fail('Group chat not found.', 404, 'NOT_FOUND');
  const body = await request.json().catch(() => null) as { content?: string; senderType?: string; senderProfileID?: string } | null;
  const content = body?.content?.trim(); const senderType = body?.senderType ?? 'user';
  if (!content || !['user', 'ai', 'system'].includes(senderType)) return fail('Invalid group message.');
  const rows = await sql`insert into group_chat_messages (id, group_chat_id, sender_type, sender_profile_id, content) values (${crypto.randomUUID()}, ${groupID}, ${senderType}, ${body?.senderProfileID ?? null}, ${content}) returning id, sender_type, sender_profile_id, content_type, content, created_at`;
  await sql`update group_chats set updated_at = now() where id = ${groupID}`;
  return ok(rows[0], { status: 201 });
}
