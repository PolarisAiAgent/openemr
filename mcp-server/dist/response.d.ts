/**
 * Canonical MCP response/error helpers per the Health MCP Tools Specification.
 */
export type ErrorCode = 'invalid_request' | 'not_found' | 'conflict' | 'precondition_failed' | 'provider_error' | 'timeout' | 'internal_error';
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
export declare function success(tool: string, result: Record<string, unknown>, startMs: number): CanonicalResponse;
export declare function failure(tool: string, error: CanonicalError, httpStatus: number, startMs: number): CanonicalResponse;
export declare function invalidRequest(tool: string, message: string, startMs: number, details?: ErrorDetail[]): CanonicalResponse;
export declare function notFound(tool: string, message: string, startMs: number): CanonicalResponse;
export declare function preconditionFailed(tool: string, message: string, startMs: number): CanonicalResponse;
export declare function providerError(tool: string, message: string, startMs: number, retryable?: boolean): CanonicalResponse;
/** Tools that require a persistence backend return this when it is not configured. */
export declare function persistenceNotConfigured(tool: string, startMs: number): CanonicalResponse;
export declare function toMcpContent(r: CanonicalResponse): {
    content: Array<{
        type: 'text';
        text: string;
    }>;
};
/** Wrap an async handler so any thrown error produces a canonical provider_error. */
export declare function withCanonical(tool: string, fn: (startMs: number) => Promise<CanonicalResponse>): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
}>;
