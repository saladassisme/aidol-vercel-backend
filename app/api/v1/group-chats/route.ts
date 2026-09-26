import { fail } from '@/lib/response';

export const runtime = 'nodejs';

// Group chat history is local-only. AI replies use /api/v1/chat/reply with
// ephemeral turn idempotency records and never call this endpoint.
export async function GET() {
  return fail('Group chat history is local-only.', 410, 'GROUP_CHAT_STORAGE_REMOVED');
}

export async function POST() {
  return fail('Group chat history is local-only.', 410, 'GROUP_CHAT_STORAGE_REMOVED');
}
