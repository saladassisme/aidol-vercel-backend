import { fail, ok } from '@/lib/response';
import { limitsForMember } from '@/lib/membership';
import { getOrCreateUserQuotaStatus } from '@/lib/quota';
import { setCachedUserAccess } from '@/lib/db';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  logIncomingRequest('quota.status', request);
  try {
    const deviceId = request.headers.get('x-aidol-device-id')?.trim();
    if (!deviceId) {
      return fail('Missing x-aidol-device-id header.', 401, 'UNAUTHORIZED');
    }

    const row = await getOrCreateUserQuotaStatus(deviceId);
    if (!row) {
      throw new Error('Unable to resolve user access.');
    }
    setCachedUserAccess(deviceId, {
      id: row.id,
      device_id: row.device_id,
      product_id: row.product_id,
      expires_at: row.expires_at,
      plan: row.plan,
      is_member: row.is_member
    });
    return ok({
      membership: {
        isMember: row.is_member,
        productId: row.product_id,
        expiresAt: row.expires_at,
        plan: row.plan,
        limits: limitsForMember(row.is_member)
      },
      usage: {
        chat_reply_count: row.chat_reply_count,
        tts_count: row.tts_count,
        voice_clone_count: row.voice_clone_count,
        theater_session_count: row.theater_session_count
      },
      trials: {
        voiceLetterTrialUsed: Boolean(row.voice_letter_trial_used_at),
        theaterTrialUsed: Boolean(row.theater_trial_used_at)
      }
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'QUOTA_STATUS_FAILED');
  }
}
