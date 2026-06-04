import { SignJWT } from 'jose';
import { requiredEnv, optionalEnv } from './env';
import { sql } from './db';

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

  return new SignJWT({ bid: bundleId })
    .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
    .setIssuer(issuerId)
    .setAudience('appstoreconnect-v1')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);
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
  if (status === 404) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes('transaction id not found') ||
    lower.includes('not found') ||
    lower.includes('404000')
  );
}

async function fetchAppleTransactionInfoInEnvironment(
  transactionId: string,
  environment: AppleStoreEnvironment
): Promise<AppleTransactionInfo> {
  const token = await appStoreJWT();
  const response = await fetch(
    `${appleStoreBaseURL(environment)}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
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
    }
  }

  throw lastError ?? new Error('Apple transaction verification failed.');
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
