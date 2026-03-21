/**
 * HTTP client for the OpenEMR REST API.
 *
 * Improvements over the original:
 * - Per-request timeout via AbortController (OPENEMR_TIMEOUT_MS, default 10 s)
 * - Automatic retry for safe (GET) requests on transient 429/5xx and network errors
 *   (up to 3 attempts, exponential back-off: 250 ms / 500 ms)
 * - Structured OpenEMRError with semantic codes, mapped to canonical MCP codes
 *   in response.ts so callers never need to parse error strings
 * - Write requests are NOT retried unless the caller provides an idempotency key
 *   (enforced by convention — the idempotency store in middleware/idempotency.ts)
 */
import { getAccessToken, getBaseUrl } from './auth.js';
import { OpenEMRError } from './errors.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

const SAFE_METHODS = new Set<HttpMethod>(['GET']);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2; // 3 total attempts for safe methods

function timeoutMs(): number {
  const v = parseInt(process.env['OPENEMR_TIMEOUT_MS'] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mapHttpError(status: number, text: string, path: string): OpenEMRError {
  if (status === 401 || status === 403) {
    return new OpenEMRError('auth_error', `Auth failed for ${path}: ${text}`, false, status);
  }
  if (status === 404) {
    return new OpenEMRError('not_found', `Not found: ${path}`, false, 404);
  }
  if (status === 409) {
    return new OpenEMRError('conflict', `Conflict on ${path}: ${text}`, false, 409);
  }
  return new OpenEMRError(
    'provider_error',
    `OpenEMR ${status} ${path}: ${text}`,
    RETRYABLE_STATUS.has(status),
    status,
  );
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const ms = timeoutMs();
  const maxAttempts = SAFE_METHODS.has(method) ? MAX_RETRIES + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), ms);

    try {
      const token = await getAccessToken();
      const url = `${getBaseUrl()}/apis/default${path}`;
      const init: RequestInit = {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);

      const res = await fetch(url, init);
      clearTimeout(tid);

      if (!res.ok) {
        const text = await res.text();
        const err = mapHttpError(res.status, text, path);
        if (err.retryable && attempt < maxAttempts - 1) {
          await sleep(2 ** attempt * 250);
          continue;
        }
        throw err;
      }

      if (res.status === 204) return undefined as unknown as T;
      return res.json() as Promise<T>;

    } catch (err) {
      clearTimeout(tid);
      if (err instanceof OpenEMRError) throw err;

      // AbortError = timeout
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (attempt < maxAttempts - 1) {
          await sleep(2 ** attempt * 250);
          continue;
        }
        throw new OpenEMRError('upstream_timeout', `Request to ${path} timed out after ${ms}ms`, false, 504);
      }

      // Network error on a safe method — retry
      if (SAFE_METHODS.has(method) && attempt < maxAttempts - 1) {
        await sleep(2 ** attempt * 250);
        continue;
      }
      throw err;
    }
  }

  throw new OpenEMRError('provider_error', `Max retries exceeded for ${path}`, false);
}

export const openemr = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: Record<string, unknown>) => request<T>('POST', path, body),
  put: <T>(path: string, body: Record<string, unknown>) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: Record<string, unknown>) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
