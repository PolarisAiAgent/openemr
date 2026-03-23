/**
 * Clinic info tools — canonical names:
 *   health_get_office_hours
 *   health_get_location
 *   health_get_billing_policy
 *   health_get_procedure_catalog
 *
 * OpenEMR REST surface:
 *   GET /api/facility               — location data
 *   GET /fhir/ValueSet              — appointment/procedure types (appointment-type ValueSet)
 *
 * Office hours and billing policy are config-driven (from environment variables
 * OFFICE_HOURS_JSON and BILLING_POLICY_JSON). If not configured, reasonable
 * defaults or a no-data message is returned.
 */

import { z } from 'zod';
import { openemr } from '../openemr-client.js';
import { CanonicalResponse, success } from '../response.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

export const getOfficeHoursSchema = z.object({
  location_id: z.string().optional().describe('Filter by location/facility ID'),
  day: z.string().optional().describe('Filter by weekday (e.g. monday, tuesday)'),
});

export const getLocationSchema = z.object({
  location_id: z.string().optional().describe('Exact location ID or facility code'),
  query: z.string().optional().describe('Search query over name, address, or city fields'),
  limit: z.number().int().optional().describe('Max results (default 20)'),
});

export const getBillingPolicySchema = z.object({
  topic: z.enum(['insurance', 'copay', 'cancellation', 'refund', 'payment_plan']).optional()
    .describe('Filter by policy topic'),
});

export const getProcedureCatalogSchema = z.object({
  procedure_code: z.string().optional().describe('Exact procedure/category code filter'),
  query: z.string().optional().describe('Fuzzy search over name and description'),
  limit: z.number().int().optional().describe('Max results (default 20)'),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FacilityRecord {
  id?: string | number;
  name?: string;
  street?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country_code?: string;
  phone?: string;
  fax?: string;
  [key: string]: unknown;
}

interface FhirConcept {
  code?: string;
  display?: string;
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

function normalizeFacility(f: FacilityRecord): Record<string, unknown> {
  return {
    location_id: String(f.id ?? ''),
    name: f.name ?? null,
    address: [f.street, f.city, f.state, f.postal_code].filter(Boolean).join(', '),
    street: f.street ?? null,
    city: f.city ?? null,
    state: f.state ?? null,
    postal_code: f.postal_code ?? null,
    country: f.country_code ?? null,
    phone: f.phone ?? null,
    fax: f.fax ?? null,
  };
}

function loadJson(envKey: string): unknown | null {
  const raw = process.env[envKey];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Default office hours used when OFFICE_HOURS_JSON is not configured
const DEFAULT_OFFICE_HOURS = [
  { day: 'monday',    open: '08:00', close: '17:00', closed: false },
  { day: 'tuesday',   open: '08:00', close: '17:00', closed: false },
  { day: 'wednesday', open: '08:00', close: '17:00', closed: false },
  { day: 'thursday',  open: '08:00', close: '17:00', closed: false },
  { day: 'friday',    open: '08:00', close: '17:00', closed: false },
  { day: 'saturday',  open: null,    close: null,     closed: true },
  { day: 'sunday',    open: null,    close: null,     closed: true },
];

// ── Handlers ──────────────────────────────────────────────────────────────────

/** health_get_office_hours */
export async function getOfficeHours(
  params: z.infer<typeof getOfficeHoursSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const configured = loadJson('OFFICE_HOURS_JSON');
  let hours = Array.isArray(configured) ? configured : DEFAULT_OFFICE_HOURS;

  if (params.day) {
    const dayLower = params.day.toLowerCase();
    hours = hours.filter((h) => (h as { day: string }).day === dayLower);
  }

  if (params.location_id) {
    // Fetch facility name to attach location context
    const raw = await openemr.get<unknown>(`/api/facility/${params.location_id}`);
    const fac = extractList<FacilityRecord>(raw)[0];
    return success('health_get_office_hours', {
      tool: 'health_get_office_hours',
      office_hours: hours,
      count: hours.length,
      filters: { location_id: params.location_id, location_name: fac?.name ?? null, day: params.day ?? null },
    }, startMs);
  }

  return success('health_get_office_hours', {
    tool: 'health_get_office_hours',
    office_hours: hours,
    count: hours.length,
    filters: { day: params.day ?? null },
  }, startMs);
}

/** health_get_location */
export async function getLocation(
  params: z.infer<typeof getLocationSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const limit = params.limit && params.limit > 0 ? params.limit : 20;
  let raw: unknown;

  if (params.location_id) {
    raw = await openemr.get<unknown>(`/api/facility/${params.location_id}`);
  } else {
    raw = await openemr.get<unknown>('/api/facility');
  }

  let facilities = extractList<FacilityRecord>(raw);

  if (params.query) {
    const q = params.query.toLowerCase();
    facilities = facilities.filter(
      (f) =>
        (f.name ?? '').toLowerCase().includes(q) ||
        (f.street ?? '').toLowerCase().includes(q) ||
        (f.city ?? '').toLowerCase().includes(q),
    );
  }

  facilities = facilities.slice(0, limit);
  const locations = facilities.map(normalizeFacility);

  return success('health_get_location', {
    tool: 'health_get_location',
    locations,
    count: locations.length,
    filters: { location_id: params.location_id ?? null, query: params.query ?? null },
  }, startMs);
}

/** health_get_billing_policy */
export async function getBillingPolicy(
  params: z.infer<typeof getBillingPolicySchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const configured = loadJson('BILLING_POLICY_JSON');

  if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
    const policies = configured as Record<string, unknown>;
    const result = params.topic ? { [params.topic]: policies[params.topic] ?? null } : policies;
    return success('health_get_billing_policy', {
      tool: 'health_get_billing_policy',
      billing_policy: result,
      topic: params.topic ?? null,
    }, startMs);
  }

  const defaultText = params.topic
    ? `Billing policy for "${params.topic}" is not configured. Please contact the clinic directly.`
    : 'Billing policy is not configured. Set BILLING_POLICY_JSON environment variable or contact the clinic.';

  return success('health_get_billing_policy', {
    tool: 'health_get_billing_policy',
    billing_policy_text: defaultText,
    topic: params.topic ?? null,
  }, startMs);
}

/** health_get_procedure_catalog */
export async function getProcedureCatalog(
  params: z.infer<typeof getProcedureCatalogSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const limit = params.limit && params.limit > 0 ? params.limit : 20;

  // Appointment categories are not in list_options; they live in
  // openemr_postcalendar_categories, exposed only via FHIR ValueSet.
  const raw = await openemr.get<unknown>('/fhir/ValueSet');

  // Extract the appointment-type ValueSet entry from the FHIR Bundle
  let concepts: FhirConcept[] = [];
  if (raw && typeof raw === 'object') {
    const bundle = raw as { entry?: Array<{ resource?: { id?: string; compose?: { include?: Array<{ concept?: FhirConcept[] }> } } }> };
    const apptEntry = bundle.entry?.find((e) => e.resource?.id === 'appointment-type');
    concepts = apptEntry?.resource?.compose?.include?.[0]?.concept ?? [];
  }

  if (params.procedure_code) {
    concepts = concepts.filter((c) => c.code === params.procedure_code);
  }

  if (params.query) {
    const q = params.query.toLowerCase();
    concepts = concepts.filter(
      (c) =>
        (c.code ?? '').toLowerCase().includes(q) ||
        (c.display ?? '').toLowerCase().includes(q),
    );
  }

  concepts = concepts.slice(0, limit);

  const catalog = concepts.map((c) => ({
    procedure_code: c.code ?? null,
    name: c.display ?? null,
    description: null,
    duration_minutes: null,
    color: null,
  }));

  return success('health_get_procedure_catalog', {
    tool: 'health_get_procedure_catalog',
    procedure_catalog: catalog,
    count: catalog.length,
    filters: { procedure_code: params.procedure_code ?? null, query: params.query ?? null },
  }, startMs);
}
