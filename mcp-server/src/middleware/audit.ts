/**
 * Structured audit logging.
 * Every tool call (success or failure) writes a single JSON line to stderr.
 * In production, pipe stderr to your log aggregator (Loki, CloudWatch, etc.).
 *
 * Fields:
 *   ts             ISO-8601 timestamp
 *   tool           canonical tool name
 *   ok             true on success
 *   elapsed_ms     wall-clock duration
 *   patient_id     when available (never masked in audit log — log pipeline must be PHI-safe)
 *   idempotency_key when provided by caller
 *   error_code     canonical error code on failure
 */
export interface AuditEntry {
  tool: string;
  ok: boolean;
  elapsed_ms: number;
  patient_id?: string | null;
  idempotency_key?: string;
  error_code?: string;
}

export function auditLog(entry: AuditEntry): void {
  const record = { ts: new Date().toISOString(), ...entry };
  process.stderr.write(JSON.stringify(record) + '\n');
}
