import { sql } from '@vercel/postgres';

export { sql };

export type UserRow = {
  id: string;
  device_id: string;
};

export async function getOrCreateUser(deviceId: string): Promise<UserRow> {
  const existing = await sql<UserRow>`select id, device_id from users where device_id = ${deviceId} limit 1`;
  if (existing.rows[0]) return existing.rows[0];

  const id = crypto.randomUUID();
  const inserted = await sql<UserRow>`
    insert into users (id, device_id)
    values (${id}, ${deviceId})
    returning id, device_id
  `;
  return inserted.rows[0];
}
