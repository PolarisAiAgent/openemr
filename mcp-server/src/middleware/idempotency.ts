/**
 * In-memory idempotency store for write tools.
 *
 * When a caller supplies an idempotency_key:
 *   - First call: execute normally, cache result for 24 hours
 *   - Subsequent calls with same key: return cached result immediately
 *
 * This is single-process memory. For multi-instance deployments, replace
 * with a shared store (Redis, DynamoDB, etc.).
 *
 * Lazy cleanup runs on every access; max store size is capped at 5000 entries
 * to prevent unbounded growth under sustained load.
 */
import type { CanonicalResponse } from '../response.js';

interface Entry {
  result: CanonicalResponse;
  expiresAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SIZE = 5_000;

const store = new Map<string, Entry>();

function cleanup(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
  // If still too large after expiry cleanup, evict oldest entries
  if (store.size > MAX_SIZE) {
    const overflow = store.size - MAX_SIZE;
    let removed = 0;
    for (const k of store.keys()) {
      store.delete(k);
      if (++removed >= overflow) break;
    }
  }
}

/** Returns a cached response if the key was already used, otherwise null. */
export function checkIdempotency(key: string | undefined): CanonicalResponse | null {
  if (!key) return null;
  cleanup();
  const entry = store.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.result;
  return null;
}

/** Caches the response under the given key for 24 hours. No-op when key is undefined. */
export function storeIdempotency(key: string | undefined, result: CanonicalResponse): void {
  if (!key) return;
  store.set(key, { result, expiresAt: Date.now() + TTL_MS });
}
