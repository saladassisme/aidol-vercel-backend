import { sql } from '@/lib/db';
import { requireAuth, isResponse } from '@/lib/auth';
import { fail, ok } from '@/lib/response';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ groupID: string }> }) {
  const auth = await requireAuth(request); if (isResponse(auth)) return auth;
  const { groupID } = await context.params;
  const rows = await sql`select id, name, member_profile_ids, preferred_mode, created_at, updated_at from group_chats where id = ${groupID} and user_id = ${auth.userId}`;
  if (!rows[0]) return fail('Group chat not found.', 404, 'NOT_FOUND');
  const messages = await sql`select id, sender_type, sender_profile_id, content_type, content, payload, created_at from group_chat_messages where group_chat_id = ${groupID} order by created_at asc`;
  return ok({ ...rows[0], messages });
}

export async function PATCH(request: Request, context: { params: Promise<{ groupID: string }> }) {
  const auth = await requireAuth(request); if (isResponse(auth)) return auth;
  const { groupID } = await context.params;
  const body = await request.json().catch(() => null) as { name?: string; memberProfileIDs?: string[]; preferredMode?: string } | null;
  const name = body?.name?.trim(); const ids = Array.isArray(body?.memberProfileIDs) ? body.memberProfileIDs : undefined;
  const preferredMode = body?.preferredMode === 'learning' || body?.preferredMode === 'chat' ? body.preferredMode : undefined;
  if (!name && !ids && !preferredMode) return fail('No group changes supplied.');
  if (ids && (ids.length < 2 || ids.length > 5)) return fail('A group chat needs 2 to 5 AI members.');
  const rows = await sql`update group_chats set name = coalesce(${name ?? null}, name), member_profile_ids = coalesce(${ids ? JSON.stringify(ids) : null}::jsonb, member_profile_ids), preferred_mode = coalesce(${preferredMode ?? null}, preferred_mode), updated_at = now() where id = ${groupID} and user_id = ${auth.userId} returning id, name, member_profile_ids, preferred_mode, created_at, updated_at`;
  if (!rows[0]) return fail('Group chat not found.', 404, 'NOT_FOUND');
  return ok(rows[0]);
}

export async function DELETE(request: Request, context: { params: Promise<{ groupID: string }> }) {
  const auth = await requireAuth(request); if (isResponse(auth)) return auth;
  const { groupID } = await context.params;
  const rows = await sql`delete from group_chats where id = ${groupID} and user_id = ${auth.userId} returning id`;
  if (!rows[0]) return fail('Group chat not found.', 404, 'NOT_FOUND');
  return ok({ id: groupID });
}
