import { fail, ok } from '@/lib/response';
import { isResponse, requireAuth } from '@/lib/auth';
import { getMembership } from '@/lib/membership';
import { getFeatureTrialStatus, getTodayUsage } from '@/lib/quota';
import { logIncomingRequest } from '@/lib/request-log';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  logIncomingRequest('quota.status', request);
  try {
    const auth = await requireAuth(request);
    if (isResponse(auth)) return auth;

    const membership = await getMembership(auth.userId);
    const usage = await getTodayUsage(auth.userId);
    const trials = await getFeatureTrialStatus(auth.userId);
    return ok({ membership, usage, trials });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Unknown error', 500, 'QUOTA_STATUS_FAILED');
  }
}
