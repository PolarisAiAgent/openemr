/**
 * Canonical MCP response/error helpers per the Health MCP Tools Specification.
 *
 * Extended error codes (superset of spec §16.6):
 *   The spec defines the minimum set. These additional codes help agentic
 *   callers and voice clients recover without parsing error messages.
 */
import { OpenEMRError } from './errors.js';
import { auditLog } from './middleware/audit.js';

export type ErrorCode =
  // Spec §16.6 canonical codes
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'provider_error'
  | 'timeout'
  | 'internal_error'
  // Extended codes for richer agent recovery
  | 'auth_error'          // 401/403 from OpenEMR
  | 'slot_unavailable'    // booking race — slot taken between check and commit
  | 'upstream_timeout';   // OpenEMR request timed out

/** Map internal OpenEMRError codes to canonical/extended ErrorCode. */
const OPENEMR_CODE_MAP: Record<string, ErrorCode> = {
  auth_error: 'auth_error',
  not_found: 'not_found',
  conflict: 'conflict',
  slot_unavailable: 'slot_unavailable',
  upstream_timeout: 'upstream_timeout',
  provider_error: 'provider_error',
};

export interface ErrorDetail {
  field: string;
  issue: string;
}

export interface CanonicalError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: ErrorDetail[];
}

export interface CanonicalMeta {
  tool: string;
  provider: string;
  elapsed_ms: number;
  provider_request_id?: string;
  request_id?: string;
}

export interface CanonicalResponse {
  ok: boolean;
  status: number;
  result: Record<string, unknown>;
  meta: CanonicalMeta;
}

const PROVIDER_ID = 'openemr';

export function success(
  tool: string,
  result: Record<string, unknown>,
  startMs: number,
): CanonicalResponse {
  return {
    ok: true,
    status: 200,
    result,
    meta: { tool, provider: PROVIDER_ID, elapsed_ms: Date.now() - startMs },
  };
}

export function failure(
  tool: string,
  error: CanonicalError,
  httpStatus: number,
  startMs: number,
): CanonicalResponse {
  return {
    ok: false,
    status: httpStatus,
    result: { status: 'error', error },
    meta: { tool, provider: PROVIDER_ID, elapsed_ms: Date.now() - startMs },
  };
}

export function invalidRequest(
  tool: string,
  message: string,
  startMs: number,
  details?: ErrorDetail[],
): CanonicalResponse {
  return failure(tool, { code: 'invalid_request', message, retryable: false, details }, 400, startMs);
}

export function notFound(tool: string, message: string, startMs: number): CanonicalResponse {
  return failure(tool, { code: 'not_found', message, retryable: false }, 404, startMs);
}

export function preconditionFailed(tool: string, message: string, startMs: number): CanonicalResponse {
  return failure(tool, { code: 'precondition_failed', message, retryable: false }, 412, startMs);
}

export function providerError(
  tool: string,
  message: string,
  startMs: number,
  retryable = false,
): CanonicalResponse {
  return failure(tool, { code: 'provider_error', message, retryable }, 502, startMs);
}

export function slotUnavailable(tool: string, startMs: number): CanonicalResponse {
  return failure(
    tool,
    { code: 'slot_unavailable', message: 'The slot is no longer available. Please check slots and try again.', retryable: false },
    409,
    startMs,
  );
}

export function persistenceNotConfigured(tool: string, startMs: number): CanonicalResponse {
  return preconditionFailed(
    tool,
    'Persistence backend is not configured. Deploy a persistence adapter to enable this tool.',
    startMs,
  );
}

export function toMcpContent(r: CanonicalResponse): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
}

/**
 * Wraps an async tool handler:
 *   - Catches OpenEMRError and maps to canonical response
 *   - Catches unexpected errors and returns internal_error
 *   - Emits a structured audit log line on every call
 *
 * Optional auditExtra lets handlers pass patient_id and idempotency_key
 * for the audit record without forcing a separate auditLog() call.
 */
export async function withCanonical(
  tool: string,
  fn: (startMs: number) => Promise<CanonicalResponse>,
  auditExtra?: { patient_id?: string | null; idempotency_key?: string },
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const startMs = Date.now();
  let result: CanonicalResponse;

  try {
    result = await fn(startMs);
  } catch (err) {
    if (err instanceof OpenEMRError) {
      const code = (OPENEMR_CODE_MAP[err.code] ?? 'provider_error') as ErrorCode;
      result = failure(
        tool,
        { code, message: err.message, retryable: err.retryable },
        err.httpStatus,
        startMs,
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      result = failure(tool, { code: 'internal_error', message: msg, retryable: false }, 500, startMs);
    }
  }

  auditLog({
    tool,
    ok: result.ok,
    elapsed_ms: result.meta.elapsed_ms,
    patient_id: auditExtra?.patient_id,
    idempotency_key: auditExtra?.idempotency_key,
    error_code: result.ok ? undefined : (result.result['error'] as CanonicalError | undefined)?.code,
  });

  return toMcpContent(result);
}
