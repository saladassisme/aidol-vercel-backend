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
 * Prefer an explicit DATABASE_URL, then fall back to the integration-provided POSTGRES_URL.
 */
function pickDatabaseURL(): string {
  const explicitDatabaseURL = optionalEnv('DATABASE_URL');
  if (explicitDatabaseURL) {
    if (process.env.VERCEL && isDirectSupabaseURL(explicitDatabaseURL)) {
      throw new Error(
        'DATABASE_URL uses Supabase direct (db.*.supabase.co:5432). ' +
          'In Vercel → Environment Variables, set DATABASE_URL to Supabase Connect → URI → Transaction (port 6543, pooler host).'
      );
    }

    const legacyPostgresURL = optionalEnv('POSTGRES_URL');
    if (legacyPostgresURL && legacyPostgresURL !== explicitDatabaseURL) {
      console.warn('[aidol] DATABASE_URL is set; ignoring POSTGRES_URL.');
    }

    return explicitDatabaseURL;
  }

  const poolerUrl = optionalEnv('POSTGRES_URL') || optionalEnv('POSTGRES_PRISMA_URL');
  if (poolerUrl) return poolerUrl;

  throw new Error('Missing DATABASE_URL or POSTGRES_URL.');
}

export const databaseURL = pickDatabaseURL();
