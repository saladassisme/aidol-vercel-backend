import { optionalEnv } from './env';

function isPoolerURL(url: string) {
  return (
    url.includes('pooler.supabase.com') ||
    url.includes('pgbouncer=true') ||
    url.includes(':6543/')
  );
}

function isDirectSupabaseURL(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.startsWith('db.') &&
      parsed.hostname.endsWith('.supabase.co') &&
      (parsed.port === '5432' || parsed.port === '')
    );
  } catch {
    return false;
  }
}

/**
 * Pick the best Postgres URL for Vercel serverless.
 * Prefer Supabase Transaction pooler (6543) over manual direct db.*:5432 URLs.
 */
function pickDatabaseURL(): string {
  const candidates = [
    optionalEnv('POSTGRES_URL'),
    optionalEnv('DATABASE_URL'),
    optionalEnv('POSTGRES_PRISMA_URL')
  ].filter((value) => value.length > 0);

  const pooler = candidates.find(isPoolerURL);
  if (pooler) return pooler;

  if (process.env.VERCEL) {
    const direct = candidates.find(isDirectSupabaseURL);
    if (direct) {
      throw new Error(
        'DATABASE_URL/POSTGRES_URL uses Supabase direct (db.*.supabase.co:5432). ' +
          'In Vercel → Environment Variables, set DATABASE_URL to Supabase Connect → URI → Transaction (port 6543, pooler host). ' +
          'Or delete manual DATABASE_URL and use the pooled POSTGRES_URL from the Supabase integration.'
      );
    }
  }

  const fallback = candidates[0];
  if (!fallback) {
    throw new Error('Missing DATABASE_URL or POSTGRES_URL.');
  }
  return fallback;
}

export const databaseURL = pickDatabaseURL();
