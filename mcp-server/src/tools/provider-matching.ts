/**
 * Provider matching and patient preferences tools — canonical names:
 *   health_match_provider
 *   health_patient_preferences_upsert
 *   health_patient_preferences_get
 *
 * health_match_provider: implemented using OpenEMR provider/user data.
 * Preferences tools: require a persistence backend (return precondition_failed
 * when PREFERENCES_BACKEND_URL is not configured).
 */

import { z } from 'zod';
import { openemr } from '../openemr-client.js';
import {
  CanonicalResponse,
  success,
  invalidRequest,
  persistenceNotConfigured,
  providerError,
} from '../response.js';
import { resolveDate } from '../utils/date.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

const slotCandidateSchema = z.object({
  slot_id: z.string(),
  provider_id: z.string(),
  location_id: z.string().optional(),
  start_at: z.string(),
  end_at: z.string(),
});

export const matchProviderSchema = z.object({
  visit_type: z.string().describe('Canonical visit type'),
  request_start_date: z.string().describe('Search start date (YYYY-MM-DD)'),
  request_end_date: z.string().describe('Search end date (YYYY-MM-DD, must be >= start date)'),
  duration_minutes: z.number().int().positive().describe('Appointment duration in minutes'),
  max_results: z.number().int().min(1).max(20).describe('Maximum number of provider matches (1-20)'),
  patient_id: z.string().optional().describe('Optional patient linkage'),
  timezone: z.string().optional().describe('IANA timezone'),
  include_saved_preferences: z.boolean().optional().describe('Whether to merge saved preferences'),
  preferred_provider_ids: z.array(z.string()).optional().describe('Preferred provider IDs list'),
  provider_gender: z.enum(['female', 'male', 'nonbinary', 'no_preference', 'unknown']).optional(),
  language: z.string().optional().describe('Preferred language tag'),
  time_of_day: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(),
  location_id: z.string().optional().describe('Preferred location ID'),
  slot_candidates: z.array(slotCandidateSchema).optional().describe('Precomputed slot candidates'),
});

const preferencesShape = z.object({
  preferred_provider_ids: z.array(z.string()).optional(),
  provider_gender: z.enum(['female', 'male', 'nonbinary', 'no_preference', 'unknown']).optional(),
  language: z.string().optional(),
  time_of_day: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(),
  location_id: z.string().optional(),
});

export const preferencesUpsertSchema = z.object({
  patient_id: z.string().describe('Canonical patient identifier'),
  preferences: preferencesShape.describe('Preference fields to update'),
  mode: z.enum(['merge', 'replace']).optional().describe('Update mode (default merge)'),
});

export const preferencesGetSchema = z.object({
  patient_id: z.string().describe('Canonical patient identifier'),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ProviderRecord {
  id?: string | number;
  fname?: string;
  lname?: string;
  specialty?: string;
  facility_id?: string | number;
  gender?: string;
  language?: string;
  npi?: string;
  [key: string]: unknown;
}

function extractList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object' && 'data' in data) {
    const inner = (data as { data: unknown }).data;
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

function normalizeProvider(p: ProviderRecord): Record<string, unknown> {
  return {
    provider_id: String(p.id ?? ''),
    name: [p.fname, p.lname].filter(Boolean).join(' '),
    specialty: p.specialty ?? null,
    location_id: p.facility_id ? String(p.facility_id) : null,
    gender: p.gender ?? null,
    language: p.language ?? null,
    npi: p.npi ?? null,
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/** health_match_provider */
export async function matchProvider(
  params: z.infer<typeof matchProviderSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const startDate = resolveDate(params.request_start_date);
  const endDate = resolveDate(params.request_end_date);

  if (!startDate || !endDate) {
    return invalidRequest('health_match_provider', 'Invalid request_start_date or request_end_date', startMs);
  }
  if (endDate < startDate) {
    return invalidRequest(
      'health_match_provider',
      'request_end_date must be >= request_start_date',
      startMs,
      [{ field: 'request_end_date', issue: 'must be >= request_start_date' }],
    );
  }

  // Fetch all active providers from OpenEMR
  const raw = await openemr.get<unknown>('/api/user?active=1&role=physician');
  let providers = extractList<ProviderRecord>(raw);

  if (providers.length === 0) {
    // Fallback: try generic user list
    const fallback = await openemr.get<unknown>('/api/user');
    providers = extractList<ProviderRecord>(fallback);
  }

  if (providers.length === 0) {
    return providerError('health_match_provider', 'No providers found in OpenEMR', startMs);
  }

  // Apply preference filters
  let filtered = providers;

  if (params.preferred_provider_ids && params.preferred_provider_ids.length > 0) {
    const preferred = new Set(params.preferred_provider_ids);
    const preferredProviders = filtered.filter((p) => preferred.has(String(p.id ?? '')));
    // If preferred providers exist, prioritize them; otherwise fall through
    if (preferredProviders.length > 0) filtered = preferredProviders;
  }

  if (params.provider_gender && params.provider_gender !== 'no_preference' && params.provider_gender !== 'unknown') {
    const genderFiltered = filtered.filter(
      (p) => (p.gender ?? '').toLowerCase() === params.provider_gender,
    );
    if (genderFiltered.length > 0) filtered = genderFiltered;
  }

  if (params.language) {
    const langFiltered = filtered.filter(
      (p) => (p.language ?? '').toLowerCase().includes(params.language!.toLowerCase()),
    );
    if (langFiltered.length > 0) filtered = langFiltered;
  }

  if (params.location_id) {
    const locFiltered = filtered.filter(
      (p) => String(p.facility_id ?? '') === params.location_id,
    );
    if (locFiltered.length > 0) filtered = locFiltered;
  }

  const matches = filtered.slice(0, params.max_results).map((p) => ({
    ...normalizeProvider(p),
    available_from: startDate,
    available_to: endDate,
    match_score: 1.0,
  }));

  return success('health_match_provider', {
    status: 'ok',
    used_preferences: {
      visit_type: params.visit_type,
      duration_minutes: params.duration_minutes,
      provider_gender: params.provider_gender ?? null,
      language: params.language ?? null,
      time_of_day: params.time_of_day ?? null,
      location_id: params.location_id ?? null,
    },
    matches,
  }, startMs);
}

/** health_patient_preferences_upsert — requires persistence backend */
export async function patientPreferencesUpsert(
  params: z.infer<typeof preferencesUpsertSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const backendUrl = process.env['PREFERENCES_BACKEND_URL'];
  if (!backendUrl) return persistenceNotConfigured('health_patient_preferences_upsert', startMs);

  if (!params.preferences || Object.keys(params.preferences).length === 0) {
    return invalidRequest('health_patient_preferences_upsert', 'preferences must have at least one property', startMs);
  }

  const response = await fetch(`${backendUrl}/preferences/${params.patient_id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: params.mode ?? 'merge', preferences: params.preferences }),
  });

  if (!response.ok) {
    const text = await response.text();
    return providerError('health_patient_preferences_upsert', `Persistence backend error: ${text}`, startMs);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return success('health_patient_preferences_upsert', {
    status: 'ok',
    patient_preferences: data,
  }, startMs);
}

/** health_patient_preferences_get — requires persistence backend */
export async function patientPreferencesGet(
  params: z.infer<typeof preferencesGetSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const backendUrl = process.env['PREFERENCES_BACKEND_URL'];
  if (!backendUrl) return persistenceNotConfigured('health_patient_preferences_get', startMs);

  const response = await fetch(`${backendUrl}/preferences/${params.patient_id}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (response.status === 404) {
    return success('health_patient_preferences_get', {
      status: 'ok',
      found: false,
      patient_preferences: null,
    }, startMs);
  }

  if (!response.ok) {
    const text = await response.text();
    return providerError('health_patient_preferences_get', `Persistence backend error: ${text}`, startMs);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return success('health_patient_preferences_get', {
    status: 'ok',
    found: true,
    patient_preferences: data,
  }, startMs);
}
