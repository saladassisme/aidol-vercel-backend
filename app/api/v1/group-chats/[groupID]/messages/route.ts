import { sql } from '@/lib/db';
import { requireAuth, isResponse } from '@/lib/auth';
import { fail, ok } from '@/lib/response';
import type postgres from 'postgres';

export const runtime = 'nodejs';

async function ownedGroup(groupID: string, userID: string) {
  const rows = await sql`select id from group_chats where id = ${groupID} and user_id = ${userID}`;
  return Boolean(rows[0]);
}

export async function GET(request: Request, context: { params: Promise<{ groupID: string }> }) {
  const auth = await requireAuth(request); if (isResponse(auth)) return auth;
  const { groupID } = await context.params;
  if (!await ownedGroup(groupID, auth.userId)) return fail('Group chat not found.', 404, 'NOT_FOUND');
  const rows = await sql`select id, sender_type, sender_profile_id, content_type, content, payload, created_at from group_chat_messages where group_chat_id = ${groupID} order by created_at asc`;
  return ok(rows);
}

export async function POST(request: Request, context: { params: Promise<{ groupID: string }> }) {
  const auth = await requireAuth(request); if (isResponse(auth)) return auth;
  const { groupID } = await context.params;
  if (!await ownedGroup(groupID, auth.userId)) return fail('Group chat not found.', 404, 'NOT_FOUND');
  const body = await request.json().catch(() => null) as { id?: string; content?: string; senderType?: string; senderProfileID?: string | null; payload?: postgres.JSONValue; createdAt?: string } | null;
  const id = body?.id?.trim();
  const content = body?.content?.trim(); const senderType = body?.senderType ?? 'user';
  const createdAt = body?.createdAt && !Number.isNaN(Date.parse(body.createdAt)) ? body.createdAt : new Date().toISOString();
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !content || !['user', 'ai', 'system'].includes(senderType)) return fail('Invalid group message.');
  const rows = await sql`
    insert into group_chat_messages (id, group_chat_id, sender_type, sender_profile_id, content, payload, created_at)
    values (${id}, ${groupID}, ${senderType}, ${body?.senderProfileID ?? null}, ${content}, ${sql.json(body?.payload ?? {})}, ${createdAt})
    on conflict (id) do update set
      content = excluded.content,
      payload = excluded.payload
    where group_chat_messages.group_chat_id = ${groupID}
    returning id, sender_type, sender_profile_id, content_type, content, payload, created_at
  `;
  if (!rows[0]) return fail('Message id is already in use.', 409, 'ID_CONFLICT');
  await sql`update group_chats set updated_at = now() where id = ${groupID}`;
  return ok(rows[0], { status: 201 });
}
