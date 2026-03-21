/**
 * Waitlist tools — canonical names:
 *   health_waitlist_add
 *   health_waitlist_list
 *   health_waitlist_remove
 *   health_waitlist_offer
 *   health_waitlist_confirm_offer
 *
 * All waitlist operations require a persistence backend (WAITLIST_BACKEND_URL).
 * When not configured, every call returns canonical precondition_failed per spec §16.8.
 */

import { z } from 'zod';
import {
  CanonicalResponse,
  success,
  invalidRequest,
  persistenceNotConfigured,
  providerError,
  notFound,
} from '../response.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

export const waitlistAddSchema = z.object({
  patient_id: z.string().describe('Canonical patient identifier'),
  visit_type: z.string().describe('Canonical visit type'),
  request_start_date: z.string().describe('Desired window start (YYYY-MM-DD)'),
  request_end_date: z.string().describe('Desired window end (YYYY-MM-DD)'),
  priority: z.number().int().min(1).max(5).describe('Priority 1 (highest) to 5 (lowest)'),
  channels: z.object({
    sms: z.boolean(),
    voice: z.boolean(),
    email: z.boolean(),
  }).describe('Communication channels for outreach'),
  time_of_day: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(),
  preferred_provider_ids: z.array(z.string()).optional(),
  provider_gender: z.enum(['female', 'male', 'nonbinary', 'no_preference', 'unknown']).optional(),
  language: z.string().optional(),
  location_id: z.string().optional(),
  consent_verified: z.boolean().optional().describe('Communication consent confirmed'),
  notes: z.string().optional(),
  idempotency_key: z.string().optional().describe('Unique key for safe retry'),
});

export const waitlistListSchema = z.object({
  patient_id: z.string().optional().describe('Filter by patient ID'),
  statuses: z.array(z.enum(['active', 'offered', 'booked', 'removed', 'expired'])).optional(),
  from_date: z.string().optional().describe('YYYY-MM-DD'),
  to_date: z.string().optional().describe('YYYY-MM-DD'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results (1-100)'),
  cursor: z.string().optional().describe('Pagination cursor'),
});

export const waitlistRemoveSchema = z.object({
  waitlist_entry_id: z.string().describe('Waitlist entry ID'),
  reason: z.string().optional().describe('Removal reason'),
  removed_by: z.enum(['patient', 'agent', 'system']).optional(),
  idempotency_key: z.string().optional().describe('Unique key for safe retry'),
});

export const waitlistOfferSchema = z.object({
  waitlist_entry_id: z.string().describe('Waitlist entry ID'),
  slot_id: z.string().describe('Canonical slot ID to offer'),
  provider_id: z.string().describe('Canonical provider ID'),
  start_at: z.string().describe('RFC3339 start timestamp'),
  end_at: z.string().describe('RFC3339 end timestamp (must be after start_at)'),
  offered_via: z.enum(['sms', 'voice', 'email', 'manual']),
  idempotency_key: z.string().describe('Deterministic offer key for deduplication'),
  location_id: z.string().optional(),
  expires_at: z.string().optional().describe('RFC3339 expiry timestamp'),
  expires_in_seconds: z.number().int().min(60).max(86400).optional(),
});

export const waitlistConfirmOfferSchema = z.object({
  offer_id: z.string().describe('Waitlist offer ID'),
  decision: z.enum(['accept', 'decline']),
  confirmed_via: z.enum(['sms', 'voice', 'email', 'agent', 'system']),
  idempotency_key: z.string().describe('Idempotent confirmation key'),
  patient_id: z.string().optional().describe('Optional patient identity linkage'),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function getBackend(): string | null {
  return process.env['WAITLIST_BACKEND_URL'] ?? null;
}

async function backendRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const backendUrl = getBackend()!;
  const response = await fetch(`${backendUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Waitlist backend error (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/** health_waitlist_add */
export async function waitlistAdd(
  params: z.infer<typeof waitlistAddSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  if (!getBackend()) return persistenceNotConfigured('health_waitlist_add', startMs);

  const entry = await backendRequest<Record<string, unknown>>('POST', '/waitlist', params as unknown as Record<string, unknown>);
  return success('health_waitlist_add', { status: 'ok', waitlist_entry: entry }, startMs);
}

/** health_waitlist_list */
export async function waitlistList(
  params: z.infer<typeof waitlistListSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  if (!getBackend()) return persistenceNotConfigured('health_waitlist_list', startMs);

  const qs = new URLSearchParams();
  if (params.patient_id) qs.set('patient_id', params.patient_id);
  if (params.statuses) qs.set('statuses', params.statuses.join(','));
  if (params.from_date) qs.set('from_date', params.from_date);
  if (params.to_date) qs.set('to_date', params.to_date);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);

  const data = await backendRequest<{ entries: unknown[]; next_cursor: string | null }>(
    'GET',
    `/waitlist?${qs.toString()}`,
  );

  return success('health_waitlist_list', {
    status: 'ok',
    entries: data.entries,
    next_cursor: data.next_cursor ?? null,
  }, startMs);
}

/** health_waitlist_remove */
export async function waitlistRemove(
  params: z.infer<typeof waitlistRemoveSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  if (!getBackend()) return persistenceNotConfigured('health_waitlist_remove', startMs);

  try {
    const entry = await backendRequest<Record<string, unknown>>(
      'DELETE',
      `/waitlist/${params.waitlist_entry_id}`,
      { reason: params.reason, removed_by: params.removed_by },
    );
    return success('health_waitlist_remove', { status: 'ok', waitlist_entry: entry }, startMs);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('404')) {
      return notFound('health_waitlist_remove', `Waitlist entry ${params.waitlist_entry_id} not found`, startMs);
    }
    return providerError('health_waitlist_remove', msg, startMs);
  }
}

/** health_waitlist_offer */
export async function waitlistOffer(
  params: z.infer<typeof waitlistOfferSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  if (!getBackend()) return persistenceNotConfigured('health_waitlist_offer', startMs);

  const hasExpiry = params.expires_at !== undefined || params.expires_in_seconds !== undefined;
  if (!hasExpiry) {
    return invalidRequest(
      'health_waitlist_offer',
      'Exactly one expiry mode is required: expires_at or expires_in_seconds',
      startMs,
    );
  }

  const offer = await backendRequest<Record<string, unknown>>(
    'POST',
    `/waitlist/${params.waitlist_entry_id}/offer`,
    params as unknown as Record<string, unknown>,
  );

  return success('health_waitlist_offer', { status: 'ok', offer }, startMs);
}

/** health_waitlist_confirm_offer */
export async function waitlistConfirmOffer(
  params: z.infer<typeof waitlistConfirmOfferSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  if (!getBackend()) return persistenceNotConfigured('health_waitlist_confirm_offer', startMs);

  if (!params.offer_id) {
    return invalidRequest('health_waitlist_confirm_offer', 'offer_id is required', startMs);
  }

  try {
    const result = await backendRequest<Record<string, unknown>>(
      'POST',
      `/offers/${params.offer_id}/confirm`,
      params as unknown as Record<string, unknown>,
    );

    const status = (result['status'] as string) ?? (params.decision === 'accept' ? 'accepted' : 'declined');

    return success('health_waitlist_confirm_offer', {
      status,
      offer: result['offer'] ?? result,
      booking_ref: result['booking_ref'] ?? null,
      message: result['message'] ?? `Offer ${params.decision}ed via ${params.confirmed_via}`,
    }, startMs);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('404')) {
      return success('health_waitlist_confirm_offer', {
        status: 'not_found',
        offer: null,
        booking_ref: null,
        message: `Offer ${params.offer_id} not found`,
      }, startMs);
    }
    return providerError('health_waitlist_confirm_offer', msg, startMs);
  }
}
