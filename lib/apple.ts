import { SignJWT } from 'jose';
import { Agent, fetch as undiciFetch } from 'undici';
import { requiredEnv, optionalEnv, optionalEnvInt } from './env';
import { sql } from './db';

const appleDispatcher = new Agent({
  connectTimeout: optionalEnvInt('APPLE_CONNECT_TIMEOUT_MS', 15_000),
  headersTimeout: optionalEnvInt('APPLE_HEADERS_TIMEOUT_MS', 25_000),
  bodyTimeout: optionalEnvInt('APPLE_BODY_TIMEOUT_MS', 25_000),
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000
});

let cachedAppStoreToken: { value: string; expiresAtMs: number } | null = null;

async function appleFetch(url: string, headers: Record<string, string>) {
  try {
    return await undiciFetch(url, {
      method: 'GET',
      headers,
      dispatcher: appleDispatcher
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('Timeout')
      || message.includes('ETIMEDOUT')
      || message.includes('ECONNRESET')
      || message.includes('fetch failed')
    ) {
      throw new Error(`Apple API request timed out or failed to connect: ${message}`);
    }
    throw error;
  }
}

function base64UrlDecode(input: string) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function decodeJWSPayload<T = Record<string, unknown>>(jws: string): T {
  const payload = jws.split('.')[1];
  if (!payload) throw new Error('Invalid JWS payload.');
  return JSON.parse(base64UrlDecode(payload)) as T;
}

async function appStoreJWT() {
  const now = Date.now();
  if (cachedAppStoreToken && cachedAppStoreToken.expiresAtMs > now + 60_000) {
    return cachedAppStoreToken.value;
  }

  const issuerId = requiredEnv('APPLE_ISSUER_ID');
  const keyId = requiredEnv('APPLE_KEY_ID');
  const bundleId = requiredEnv('AIDOL_BUNDLE_ID');
  const privateKeyPem = requiredEnv('APPLE_PRIVATE_KEY').replace(/\\n/g, '\n');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const token = await new SignJWT({ bid: bundleId })
    .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
    .setIssuer(issuerId)
    .setAudience('appstoreconnect-v1')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);

  cachedAppStoreToken = { value: token, expiresAtMs: now + 9 * 60_000 };
  return token;
}

export type AppleTransactionInfo = {
  transactionId: string;
  originalTransactionId?: string;
  productId: string;
  expiresDate?: number | string;
  revocationDate?: number | string;
};

type AppleStoreEnvironment = 'sandbox' | 'production';

function appleStoreBaseURL(environment: AppleStoreEnvironment) {
  return environment === 'production'
    ? 'https://api.storekit.itunes.apple.com'
    : 'https://api.storekit-sandbox.itunes.apple.com';
}

function shouldRetryAppleEnvironment(status: number, body: string) {
  if (status === 401 || status === 403) return false;
  if (status === 404) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes('transaction id not found') ||
    lower.includes('not found') ||
    lower.includes('404000')
  );
}

function shouldRetryAlternateEnvironment(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes('timed out') || message.includes('timeout')) return false;
  if (message.includes('http 401') || message.includes('http 403')) return false;
  return message.includes('not found') || message.includes('http 404') || message.includes('retryable');
}

async function fetchAppleTransactionInfoInEnvironment(
  transactionId: string,
  environment: AppleStoreEnvironment
): Promise<AppleTransactionInfo> {
  const token = await appStoreJWT();
  const response = await appleFetch(
    `${appleStoreBaseURL(environment)}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
    { Authorization: `Bearer ${token}` }
  );

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(
      `[${environment}] Apple transaction verification failed: HTTP ${response.status} ${text}`
    );
    if (shouldRetryAppleEnvironment(response.status, text)) {
      (error as Error & { retryable?: boolean }).retryable = true;
    }
    throw error;
  }

  const json = JSON.parse(text) as { signedTransactionInfo?: string };
  if (!json.signedTransactionInfo) {
    throw new Error(`[${environment}] Apple response did not include signedTransactionInfo.`);
  }

  return decodeJWSPayload<AppleTransactionInfo>(json.signedTransactionInfo);
}

/** Tries configured environment first, then the other (sandbox ↔ production). */
export async function fetchAppleTransactionInfo(transactionId: string): Promise<AppleTransactionInfo> {
  const preferred = optionalEnv('APPLE_ENVIRONMENT', 'sandbox') as AppleStoreEnvironment;
  const environments: AppleStoreEnvironment[] =
    preferred === 'production' ? ['production', 'sandbox'] : ['sandbox', 'production'];

  let lastError: Error | null = null;
  for (const environment of environments) {
    try {
      return await fetchAppleTransactionInfoInEnvironment(transactionId, environment);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!shouldRetryAlternateEnvironment(error)) break;
    }
  }

  throw lastError ?? new Error('Apple transaction verification failed.');
}

type AppleSubscriptionStatusResponse = {
  data?: Array<{
    lastTransactions?: Array<{
      signedTransactionInfo?: string;
    }>;
  }>;
};

/** Fallback when a single transaction id lookup fails (common with sandbox renewals). */
export async function fetchAppleTransactionInfoByOriginalId(
  originalTransactionId: string
): Promise<AppleTransactionInfo> {
  const preferred = optionalEnv('APPLE_ENVIRONMENT', 'sandbox') as AppleStoreEnvironment;
  const environments: AppleStoreEnvironment[] =
    preferred === 'production' ? ['production', 'sandbox'] : ['sandbox', 'production'];

  let lastError: Error | null = null;
  for (const environment of environments) {
    try {
      const token = await appStoreJWT();
      const response = await appleFetch(
        `${appleStoreBaseURL(environment)}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`,
        { Authorization: `Bearer ${token}` }
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `[${environment}] Apple subscription lookup failed: HTTP ${response.status} ${text}`
        );
      }

      const json = JSON.parse(text) as AppleSubscriptionStatusResponse;
      const signed = json.data?.[0]?.lastTransactions?.[0]?.signedTransactionInfo;
      if (!signed) {
        throw new Error(`[${environment}] Apple subscription response did not include signedTransactionInfo.`);
      }
      return decodeJWSPayload<AppleTransactionInfo>(signed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!shouldRetryAlternateEnvironment(error)) break;
    }
  }

  throw lastError ?? new Error('Apple subscription lookup failed.');
}

export async function resolveAppleTransactionInfo(input: {
  transactionId?: string;
  originalTransactionId?: string;
}): Promise<AppleTransactionInfo> {
  const transactionId = input.transactionId?.trim();
  const originalTransactionId = input.originalTransactionId?.trim();

  if (transactionId) {
    try {
      return await fetchAppleTransactionInfo(transactionId);
    } catch (error) {
      if (originalTransactionId) {
        return fetchAppleTransactionInfoByOriginalId(originalTransactionId);
      }
      throw error;
    }
  }

  if (originalTransactionId) {
    return fetchAppleTransactionInfoByOriginalId(originalTransactionId);
  }

  throw new Error('transactionId or originalTransactionId is required.');
}

export async function upsertSubscriptionFromApple(userId: string, info: AppleTransactionInfo) {
  const expires = info.expiresDate ? new Date(Number(info.expiresDate)).toISOString() : null;
  const isActive = !info.revocationDate && (!expires || new Date(expires).getTime() > Date.now());
  const id = crypto.randomUUID();
  const original = info.originalTransactionId ?? info.transactionId;

  await sql`
    insert into subscriptions (id, user_id, product_id, original_transaction_id, transaction_id, status, expires_at)
    values (${id}, ${userId}, ${info.productId}, ${original}, ${info.transactionId}, ${isActive ? 'active' : 'inactive'}, ${expires})
    on conflict (original_transaction_id) do update set
      product_id = excluded.product_id,
      transaction_id = excluded.transaction_id,
      status = excluded.status,
      expires_at = excluded.expires_at,
      updated_at = now()
  `;

  if (isActive) {
    const monthly = optionalEnv('AIDOL_PRODUCT_MONTHLY', 'aidol.membership.monthly');
    const yearly = optionalEnv('AIDOL_PRODUCT_YEARLY', 'aidol.membership.yearly');
    if (info.productId === yearly) {
      await sql`
        update subscriptions
        set status = 'inactive', updated_at = now()
        where user_id = ${userId}
          and product_id = ${monthly}
          and status = 'active'
          and original_transaction_id is distinct from ${original}
      `;
    }
  }

  return { isActive, productId: info.productId, expiresAt: expires, originalTransactionId: original };
}
