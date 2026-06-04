import postgres from 'postgres';
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

export async function getOrCreateUser(deviceId: string): Promise<UserRow> {
  const existing = await sql<UserRow[]>`
    select id, device_id from users where device_id = ${deviceId} limit 1
  `;
  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const inserted = await sql<UserRow[]>`
    insert into users (id, device_id)
    values (${id}, ${deviceId})
    returning id, device_id
  `;
  return inserted[0];
}
