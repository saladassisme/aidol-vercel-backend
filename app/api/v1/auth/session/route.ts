import { ok, fail } from '@/lib/response';
import { getOrCreateUser } from '@/lib/db';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  logIncomingRequest('auth.session', request);
  try {
    const body = await request.json().catch(() => ({}));
    const deviceId = String(body.deviceId || request.headers.get('x-aidol-device-id') || '').trim();
    if (!deviceId) return fail('deviceId is required.', 400, 'MISSING_DEVICE_ID');

    const user = await getOrCreateUser(deviceId);
    return ok({ userId: user.id, deviceId: user.device_id });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'INTERNAL_ERROR');
  }
}
