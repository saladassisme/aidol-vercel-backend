import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { optionalEnvInt } from './env';
import { dashscopeRegion } from './dashscopeRegion';

const dashscopeDispatcher = new Agent({
  connectTimeout: optionalEnvInt('DASHSCOPE_CONNECT_TIMEOUT_MS', 60_000),
  headersTimeout: optionalEnvInt('DASHSCOPE_HEADERS_TIMEOUT_MS', 180_000),
  bodyTimeout: optionalEnvInt('DASHSCOPE_BODY_TIMEOUT_MS', 180_000),
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000
});

type DashScopeRequestInit = {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
};

function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  if (!(error instanceof Error)) return codes;

  const directCode = (error as Error & { code?: string }).code;
  if (directCode) codes.push(directCode);

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof AggregateError) {
    for (const nested of cause.errors) {
      codes.push(...collectErrorCodes(nested));
    }
  } else if (cause instanceof Error) {
    codes.push(...collectErrorCodes(cause));
  }

  return codes;
}

function isRetryableDashScopeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const codes = collectErrorCodes(error);
  if (codes.some((code) => (
    code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'ECONNREFUSED'
  ))) {
    return true;
  }

  return error.message.includes('Connect Timeout')
    || error.message.includes('fetch failed')
    || error.message.includes('Headers Timeout')
    || error.message.includes('Body Timeout');
}

function dashscopeTimeoutHint(label: string): string {
  const region = dashscopeRegion();
  const endpoint = region === 'intl'
    ? 'dashscope-intl.aliyuncs.com'
    : 'dashscope.aliyuncs.com';
  return `${label} 连接 DashScope 超时（当前 region=${region}，endpoint=${endpoint}）。`
    + ' 这通常是跨境网络偶发超时，可稍后重试；若持续失败且 Key 为国际版，可设 DASHSCOPE_REGION=intl。';
}

async function undiciRequest(url: string, init: UndiciRequestInit, label: string): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[dashscope] ${label} ${init.method ?? 'GET'} ${url} attempt=${attempt}/${maxAttempts}`);
      const requestInit: UndiciRequestInit = {
        ...init,
        dispatcher: dashscopeDispatcher
      };
      return await undiciFetch(url, requestInit) as unknown as Response;
    } catch (error) {
      lastError = error;
      console.error(`[dashscope] ${label} attempt=${attempt} failed`, error);
      if (!isRetryableDashScopeError(error) || attempt === maxAttempts) {
        if (isRetryableDashScopeError(error)) {
          throw new Error(dashscopeTimeoutHint(label), { cause: error });
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }

  throw lastError instanceof Error
    ? new Error(dashscopeTimeoutHint(label), { cause: lastError })
    : lastError;
}

export async function dashscopeFetch(url: string, init: DashScopeRequestInit, label: string): Promise<Response> {
  return undiciRequest(url, init, label);
}

export async function dashscopeDownload(url: string, label: string): Promise<Response> {
  return undiciRequest(url, { method: 'GET' }, label);
}
