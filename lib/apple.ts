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

export async function fetchAppleTransactionInfo(transactionId: string): Promise<AppleTransactionInfo> {
  const env = optionalEnv('APPLE_ENVIRONMENT', 'sandbox');
  const baseURL = env === 'production'
    ? 'https://api.storekit.itunes.apple.com'
    : 'https://api.storekit-sandbox.itunes.apple.com';

  const token = await appStoreJWT();
  const response = await fetch(`${baseURL}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Apple transaction verification failed: HTTP ${response.status} ${text}`);
  }

  const json = JSON.parse(text) as { signedTransactionInfo?: string };
  if (!json.signedTransactionInfo) {
    throw new Error('Apple response did not include signedTransactionInfo.');
  }

  return decodeJWSPayload<AppleTransactionInfo>(json.signedTransactionInfo);
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

  return { isActive, productId: info.productId, expiresAt: expires, originalTransactionId: original };
}
