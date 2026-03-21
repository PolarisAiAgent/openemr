/**
 * Typed error class for OpenEMR API failures.
 * Carries a semantic code that response.ts maps to canonical MCP error codes.
 */
export type OpenEMRErrorCode =
  | 'auth_error'       // 401 / 403 → precondition_failed
  | 'not_found'        // 404       → not_found
  | 'conflict'         // 409       → conflict
  | 'slot_unavailable' // booking race → conflict
  | 'upstream_timeout' // AbortError   → timeout
  | 'provider_error';  // 5xx / other  → provider_error

export class OpenEMRError extends Error {
  constructor(
    public readonly code: OpenEMRErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly httpStatus = 502,
  ) {
    super(message);
    this.name = 'OpenEMRError';
  }
}
