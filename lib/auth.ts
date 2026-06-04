import { fail } from './response';
import { getOrCreateUser } from './db';

export type AuthContext = {
  userId: string;
  deviceId: string;
};

export async function requireAuth(request: Request): Promise<AuthContext | Response> {
  const deviceId = request.headers.get('x-aidol-device-id')?.trim();
  if (!deviceId) {
    return fail('Missing x-aidol-device-id header.', 401, 'UNAUTHORIZED');
  }

  const user = await getOrCreateUser(deviceId);
  return { userId: user.id, deviceId: user.device_id };
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}
