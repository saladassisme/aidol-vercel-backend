import { sql } from '@/lib/db';
import { requireAuth, isResponse } from '@/lib/auth';
import { fail, ok } from '@/lib/response';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (isResponse(auth)) return auth;
  const rows = await sql`select id, name, member_profile_ids, created_at, updated_at from group_chats where user_id = ${auth.userId} order by updated_at desc`;
  return ok(rows);
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (isResponse(auth)) return auth;
  const body = await request.json().catch(() => null) as { name?: string; memberProfileIDs?: string[] } | null;
  const name = body?.name?.trim();
  const memberProfileIDs = Array.isArray(body?.memberProfileIDs) ? body.memberProfileIDs : [];
  if (!name || memberProfileIDs.length < 2 || memberProfileIDs.length > 5) return fail('A group chat needs 2 to 5 AI members and a name.');
  const rows = await sql`insert into group_chats (id, user_id, name, member_profile_ids) values (${crypto.randomUUID()}, ${auth.userId}, ${name}, ${JSON.stringify(memberProfileIDs)}::jsonb) returning id, name, member_profile_ids, created_at, updated_at`;
  return ok(rows[0], { status: 201 });
}
