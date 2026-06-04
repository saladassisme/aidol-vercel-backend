import { ok } from '@/lib/response';
import { databaseURL } from '@/lib/pg-env';

export const runtime = 'nodejs';

export async function GET() {
  let host = 'unknown';
  let port = '';
  let mode: 'pooler' | 'direct' | 'other' = 'other';
  try {
    const parsed = new URL(databaseURL);
    host = parsed.hostname;
    port = parsed.port;
    if (host.includes('pooler.supabase.com') || port === '6543') mode = 'pooler';
    else if (host.startsWith('db.') && host.endsWith('.supabase.co')) mode = 'direct';
  } catch {
    // ignore parse errors for health output
  }

  return ok({
    service: 'aidol-vercel-backend',
    dbDriver: 'postgres-js',
    build: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
    database: { host, port, mode }
  });
}
