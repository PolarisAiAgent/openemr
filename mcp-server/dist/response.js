/**
 * Canonical MCP response/error helpers per the Health MCP Tools Specification.
 */
const PROVIDER_ID = 'openemr';
export function success(tool, result, startMs) {
    return {
        ok: true,
        status: 200,
        result,
        meta: { tool, provider: PROVIDER_ID, elapsed_ms: Date.now() - startMs },
    };
}
export function failure(tool, error, httpStatus, startMs) {
    return {
        ok: false,
        status: httpStatus,
        result: { status: 'error', error },
        meta: { tool, provider: PROVIDER_ID, elapsed_ms: Date.now() - startMs },
    };
}
export function invalidRequest(tool, message, startMs, details) {
    return failure(tool, { code: 'invalid_request', message, retryable: false, details }, 400, startMs);
}
export function notFound(tool, message, startMs) {
    return failure(tool, { code: 'not_found', message, retryable: false }, 404, startMs);
}
export function preconditionFailed(tool, message, startMs) {
    return failure(tool, { code: 'precondition_failed', message, retryable: false }, 412, startMs);
}
export function providerError(tool, message, startMs, retryable = false) {
    return failure(tool, { code: 'provider_error', message, retryable }, 502, startMs);
}
/** Tools that require a persistence backend return this when it is not configured. */
export function persistenceNotConfigured(tool, startMs) {
    return preconditionFailed(tool, 'Persistence backend is not configured. Deploy a persistence adapter to enable this tool.', startMs);
}
export function toMcpContent(r) {
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
}
/** Wrap an async handler so any thrown error produces a canonical provider_error. */
export async function withCanonical(tool, fn) {
    const startMs = Date.now();
    try {
        const result = await fn(startMs);
        return toMcpContent(result);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toMcpContent(providerError(tool, msg, startMs, true));
    }
}
