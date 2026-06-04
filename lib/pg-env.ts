import { optionalEnv } from './env';

function pickDatabaseURL(): string {
  const url = optionalEnv('DATABASE_URL') || optionalEnv('POSTGRES_URL');
  if (!url) {
    throw new Error('Missing DATABASE_URL or POSTGRES_URL.');
  }
  return url;
}

function assertSupabaseURLForServerless(url: string) {
  try {
    const parsed = new URL(url);
    const isDirectSupabase =
      parsed.hostname.startsWith('db.') &&
      parsed.hostname.endsWith('.supabase.co') &&
      (parsed.port === '5432' || parsed.port === '');

    if (isDirectSupabase) {
      throw new Error(
        'DATABASE_URL uses Supabase direct connection (db.*.supabase.co:5432). ' +
          'On Vercel, use the Transaction pooler URI from Supabase → Connect → URI (port 6543, Mode: Transaction).'
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Supabase direct')) {
      throw error;
    }
  }
}

export const databaseURL = pickDatabaseURL();

// Warn when Vercel is using Supabase direct URL (works in dev, pooler is recommended for production).
if (process.env.VERCEL) {
  try {
    assertSupabaseURLForServerless(databaseURL);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : error);
  }
}
