import { fail } from '@/lib/response';

export const runtime = 'nodejs';

export async function GET() {
  return fail('Group chat history is local-only.', 410, 'GROUP_CHAT_STORAGE_REMOVED');
}

export async function PATCH() {
  return fail('Group chat history is local-only.', 410, 'GROUP_CHAT_STORAGE_REMOVED');
}

export async function DELETE() {
  return fail('Group chat history is local-only.', 410, 'GROUP_CHAT_STORAGE_REMOVED');
}
