import postgres from 'postgres';
import { optionalEnv, optionalEnvInt } from './env';
import { databaseURL } from './pg-env';

const useTransactionPooler =
  databaseURL.includes('pooler.supabase.com') ||
  databaseURL.includes('pgbouncer=true') ||
  databaseURL.includes(':6543/');

export const sql = postgres(databaseURL, {
  ssl: 'require',
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  // Required for Supabase PgBouncer transaction mode (port 6543).
  prepare: !useTransactionPooler
});

export type UserRow = {
  id: string;
  device_id: string;
};

export type UserAccessRow = UserRow & {
  product_id: string | null;
  expires_at: string | null;
  plan: 'free' | 'monthly' | 'yearly';
  is_member: boolean;
};

type CachedUserAccess = {
  value: UserAccessRow;
  cachedAt: number;
};

const userAccessCache = new Map<string, CachedUserAccess>();

function userAccessCacheTtlMs() {
  return Math.max(optionalEnvInt('AIDOL_USER_ACCESS_CACHE_TTL_MS', 60_000), 10_000);
}

export function getCachedUserAccess(deviceId: string): UserAccessRow | null {
  const cached = userAccessCache.get(deviceId);
  if (!cached) return null;

  if (Date.now() - cached.cachedAt > userAccessCacheTtlMs()) {
    userAccessCache.delete(deviceId);
    return null;
  }

  return cached.value;
}

export function setCachedUserAccess(deviceId: string, value: UserAccessRow) {
  userAccessCache.set(deviceId, { value, cachedAt: Date.now() });
}

export function clearCachedUserAccess(deviceId: string) {
  userAccessCache.delete(deviceId);
}

export async function getOrCreateUser(deviceId: string): Promise<UserRow> {
  const id = crypto.randomUUID();
  const rows = await sql<UserRow[]>`
    with inserted as (
      insert into users (id, device_id)
      values (${id}, ${deviceId})
      on conflict (device_id) do nothing
      returning id, device_id
    )
    select id, device_id from inserted
    union all
    select id, device_id
    from users
    where device_id = ${deviceId}
      and not exists (select 1 from inserted)
    limit 1
  `;
  return rows[0];
}

export async function getOrCreateUserWithMembership(deviceId: string): Promise<UserAccessRow> {
  const id = crypto.randomUUID();
  const monthly = optionalEnv('AIDOL_PRODUCT_MONTHLY', 'aidol.membership.monthly');
  const yearly = optionalEnv('AIDOL_PRODUCT_YEARLY', 'aidol.membership.yearly');

  const rows = await sql<UserAccessRow[]>`
    with inserted as (
      insert into users (id, device_id)
      values (${id}, ${deviceId})
      on conflict (device_id) do nothing
      returning id, device_id
    ),
    user_row as (
      select id, device_id from inserted
      union all
      select id, device_id
      from users
      where device_id = ${deviceId}
        and not exists (select 1 from inserted)
      limit 1
    ),
    membership_row as (
      select product_id, expires_at,
        case
          when product_id = ${yearly} then 'yearly'
          when product_id = ${monthly} then 'monthly'
          else 'monthly'
        end as plan
      from subscriptions
      where user_id = (select id from user_row)
        and status = 'active'
        and (expires_at is null or expires_at > now())
      order by
        case
          when product_id = ${yearly} then 0
          when product_id = ${monthly} then 1
          else 2
        end,
        expires_at desc nulls first
      limit 1
    )
    select
      user_row.id,
      user_row.device_id,
      membership_row.product_id,
      membership_row.expires_at,
      coalesce(membership_row.plan, 'free') as plan,
      membership_row.product_id is not null as is_member
    from user_row
    left join membership_row on true
    limit 1
  `;

  return rows[0];
}
