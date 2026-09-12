import { fail, ok } from '@/lib/response';
import { limitsForMember } from '@/lib/membership';
import { getOrCreateUserQuotaStatus } from '@/lib/quota';
import { getQuotaSnapshots } from '@/lib/quota-engine';
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
    const membership = {
        isMember: row.is_member,
        productId: row.product_id,
        expiresAt: row.expires_at,
        plan: row.plan,
        limits: limitsForMember(row.is_member)
      };
    const quotas = await getQuotaSnapshots(row.id, membership);
    const used = (key: string) => quotas.find((quota) => quota.key === key)?.used ?? 0;
    return ok({
      membership,
      usage: {
        chat_reply_count: used('chat_reply'),
        message_send_count: used('message_send'),
        tts_count: used('voice_reply'),
        voice_letter_count: used('voice_letter'),
        voice_clone_count: used('voice_clone'),
        theater_session_count: used('theater_session')
      },
      trials: {
        voiceLetterTrialUsed: !row.is_member && used('voice_letter') > 0,
        theaterTrialUsed: !row.is_member && used('theater_session') > 0
      },
      quotas
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'QUOTA_STATUS_FAILED');
  }
}
