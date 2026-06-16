import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { optionalEnvInt } from './env';

const dashscopeDispatcher = new Agent({
  connectTimeout: optionalEnvInt('DASHSCOPE_CONNECT_TIMEOUT_MS', 60_000),
  headersTimeout: optionalEnvInt('DASHSCOPE_HEADERS_TIMEOUT_MS', 120_000),
  bodyTimeout: optionalEnvInt('DASHSCOPE_BODY_TIMEOUT_MS', 120_000)
});

type DashScopeRequestInit = {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
};

function isRetryableDashScopeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || error.message.includes('Connect Timeout')
    || error.message.includes('fetch failed');
}

export async function dashscopeFetch(url: string, init: DashScopeRequestInit, label: string): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[dashscope] ${label} POST ${url} attempt=${attempt}/${maxAttempts}`);
      const requestInit: UndiciRequestInit = {
        ...init,
        dispatcher: dashscopeDispatcher
      };
      return await undiciFetch(url, requestInit) as unknown as Response;
    } catch (error) {
      lastError = error;
      console.error(`[dashscope] ${label} attempt=${attempt} failed`, error);
      if (!isRetryableDashScopeError(error) || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }

  throw lastError;
}
