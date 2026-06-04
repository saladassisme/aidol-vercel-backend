import { sql } from './db';
import { optionalEnv } from './env';

export type MembershipState = {
  isMember: boolean;
  productId: string | null;
  expiresAt: string | null;
  plan: 'free' | 'monthly' | 'yearly';
  limits: {
    dailyChatReplies: number;
    dailyTTS: number;
    monthlyVoiceClones: number;
    maxProfiles: number;
    voiceEnabled: boolean;
    proactiveEnabled: boolean;
  };
};

export function limitsForMember(isMember: boolean) {
  if (isMember) {
    return {
      dailyChatReplies: 30,
      dailyTTS: 20,
      monthlyVoiceClones: 1,
      maxProfiles: 3,
      voiceEnabled: true,
      proactiveEnabled: true
    };
  }

  return {
    dailyChatReplies: 10,
    dailyTTS: 0,
    monthlyVoiceClones: 0,
    maxProfiles: 1,
    voiceEnabled: false,
    proactiveEnabled: false
  };
}

export async function getMembership(userId: string): Promise<MembershipState> {
  const result = await sql<{
    product_id: string;
    expires_at: string | null;
    status: string;
  }>`
    select product_id, expires_at, status
    from subscriptions
    where user_id = ${userId}
      and status = 'active'
      and (expires_at is null or expires_at > now())
    order by expires_at desc nulls first
    limit 1
  `;

  const row = result.rows[0];
  const isMember = Boolean(row);
  const monthly = optionalEnv('AIDOL_PRODUCT_MONTHLY', 'aidol.membership.monthly');
  const yearly = optionalEnv('AIDOL_PRODUCT_YEARLY', 'aidol.membership.yearly');
  const plan = !row ? 'free' : row.product_id === yearly ? 'yearly' : row.product_id === monthly ? 'monthly' : 'monthly';

  return {
    isMember,
    productId: row?.product_id ?? null,
    expiresAt: row?.expires_at ?? null,
    plan,
    limits: limitsForMember(isMember)
  };
}
