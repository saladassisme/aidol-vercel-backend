import { sql } from '@/lib/db';
import { requireAuth, isResponse } from '@/lib/auth';
import { fail, ok } from '@/lib/response';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (isResponse(auth)) return auth;
  const rows = await sql`select id, name, member_profile_ids, preferred_mode, created_at, updated_at from group_chats where user_id = ${auth.userId} order by updated_at desc`;
  return ok(rows);
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (isResponse(auth)) return auth;
  const body = await request.json().catch(() => null) as { id?: string; name?: string; memberProfileIDs?: string[]; preferredMode?: string } | null;
  const id = body?.id?.trim();
  const name = body?.name?.trim();
  const memberProfileIDs = Array.isArray(body?.memberProfileIDs) ? body.memberProfileIDs : [];
  const preferredMode = body?.preferredMode === 'chat' ? 'chat' : 'learning';
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !name || memberProfileIDs.length < 2 || memberProfileIDs.length > 5) return fail('A group chat needs a valid id, 2 to 5 AI members, and a name.');
  const rows = await sql`
    insert into group_chats (id, user_id, name, member_profile_ids, preferred_mode)
    values (${id}, ${auth.userId}, ${name}, ${JSON.stringify(memberProfileIDs)}::jsonb, ${preferredMode})
    on conflict (id) do update set
      name = excluded.name,
      member_profile_ids = excluded.member_profile_ids,
      preferred_mode = excluded.preferred_mode,
      updated_at = now()
    where group_chats.user_id = ${auth.userId}
    returning id, name, member_profile_ids, preferred_mode, created_at, updated_at
  `;
  if (!rows[0]) return fail('Group chat id is already in use.', 409, 'ID_CONFLICT');
  return ok(rows[0], { status: 201 });
}
