/** Primary name used in code → alternate names configured in Vercel/Supabase. */
const ENV_ALIASES: Record<string, string[]> = {
  POSTGRES_URL: ['DATABASE_URL'],
  AI_API_BASE_URL: ['LLM_API_BASE_URL'],
  AI_API_KEY: ['LLM_API_KEY'],
  AI_TEXT_MODEL: ['LLM_MODEL'],
  AIDOL_BUNDLE_ID: ['APPLE_BUNDLE_ID'],
  AIDOL_PRODUCT_MONTHLY: ['APPLE_MONTHLY_PRODUCT_ID'],
  AIDOL_PRODUCT_YEARLY: ['APPLE_YEARLY_PRODUCT_ID']
};

function candidateNames(primary: string): string[] {
  return [primary, ...(ENV_ALIASES[primary] ?? [])];
}

export function requiredEnv(primary: string): string {
  for (const name of candidateNames(primary)) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  throw new Error(`Missing required environment variable: ${candidateNames(primary).join(' or ')}`);
}

export function optionalEnv(primary: string, fallback = ''): string {
  for (const name of candidateNames(primary)) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

export function optionalEnvInt(primary: string, fallback: number): number {
  for (const name of candidateNames(primary)) {
    const value = process.env[name];
    if (!value || !value.trim()) continue;
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}
