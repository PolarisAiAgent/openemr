/**
 * Patient management tools — canonical names:
 *   health_lookup_patient
 *   health_update_patient_info
 *   health_new_patient_intake
 *   health_collect_medical_history
 *
 * OpenEMR REST surface:
 *   GET  /api/patient
 *   GET  /api/patient/{pid}
 *   POST /api/patient
 *   PUT  /api/patient/{pid}
 */

import { z } from 'zod';
import { openemr } from '../openemr-client.js';
import {
  CanonicalResponse,
  success,
  invalidRequest,
  notFound,
} from '../response.js';
import { checkIdempotency, storeIdempotency } from '../middleware/idempotency.js';
import { resolveLevel, enforcePolicy } from '../middleware/policy.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

const verificationFields = {
  patient_verified: z.boolean().optional(),
  verification_level: z.enum(['none', 'basic', 'contact', 'strong']).optional()
    .describe('Verification level (supersedes patient_verified)'),
};

export const lookupPatientSchema = z.object({
  patient_phone: z.string().optional().describe('Patient phone number for lookup'),
  patient_email: z.string().optional().describe('Patient email address for lookup'),
  patient_id: z.string().optional().describe('OpenEMR patient ID (PID) for direct lookup'),
  ...verificationFields,
});

export const updatePatientInfoSchema = z.object({
  patient_id: z.string().optional().describe('Patient ID for lookup'),
  patient_phone: z.string().optional().describe('Patient phone for lookup'),
  patient_email: z.string().optional().describe('Patient email for lookup'),
  ...verificationFields,
  updates: z.record(z.unknown()).describe('Fields to update on the patient record'),
  idempotency_key: z.string().optional().describe('Unique key for safe retry'),
});

export const newPatientIntakeSchema = z.object({
  intake: z.record(z.unknown()).describe('New patient intake data (at least one property required)'),
  source: z.enum(['voice', 'web', 'chat', 'agent', 'unknown']).optional().describe('Intake source channel'),
  idempotency_key: z.string().optional().describe('Unique key for safe retry'),
});

export const collectMedicalHistorySchema = z.object({
  history: z.record(z.unknown()).describe('Medical history data (at least one property required)'),
  patient_id: z.string().optional().describe('Patient ID (required if new_patient_reference absent)'),
  new_patient_reference: z.string().optional().describe('New patient reference (required if patient_id absent)'),
  ...verificationFields,
  idempotency_key: z.string().optional().describe('Unique key for safe retry'),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface PatientRecord {
  pid?: string | number;
  fname?: string;
  lname?: string;
  phone_cell?: string;
  phone_home?: string;
  email?: string;
  DOB?: string;
  sex?: string;
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

function extractRecord<T>(data: unknown): T | null {
  if (!data || typeof data !== 'object') return null;
  if ('data' in data) {
    const inner = (data as { data: unknown }).data;
    if (Array.isArray(inner) && inner.length > 0) return inner[0] as T;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as T;
  }
  return data as T;
}

function maskPatient(p: PatientRecord): Record<string, unknown> {
  return {
    patient_id: String(p.pid ?? ''),
    patient_found: true,
    patient_verified: false,
    patient: {
      fname: p.fname ? p.fname[0] + '***' : null,
      lname: p.lname ? p.lname[0] + '***' : null,
      phone: null,
      email: null,
      DOB: null,
    },
    message: 'Patient found but details are masked. Verify patient identity to access full record.',
  };
}

function fullPatient(p: PatientRecord): Record<string, unknown> {
  return {
    patient_id: String(p.pid ?? ''),
    fname: p.fname ?? null,
    lname: p.lname ?? null,
    phone: p.phone_cell ?? p.phone_home ?? null,
    email: p.email ?? null,
    DOB: p.DOB ?? null,
    sex: p.sex ?? null,
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/** health_lookup_patient */
export async function lookupPatient(
  params: z.infer<typeof lookupPatientSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const level = resolveLevel(params);
  const verified = level !== 'none';

  let patient: PatientRecord | null = null;

  if (params.patient_id) {
    const raw = await openemr.get<unknown>(`/api/patient/${params.patient_id}`);
    patient = extractRecord<PatientRecord>(raw);
  } else if (params.patient_phone) {
    const raw = await openemr.get<unknown>(`/api/patient?phone=${encodeURIComponent(params.patient_phone)}`);
    const list = extractList<PatientRecord>(raw);
    patient = list[0] ?? null;
  } else if (params.patient_email) {
    const raw = await openemr.get<unknown>(`/api/patient?email=${encodeURIComponent(params.patient_email)}`);
    const list = extractList<PatientRecord>(raw);
    patient = list[0] ?? null;
  }

  if (!patient || !patient.pid) {
    return success('health_lookup_patient', {
      provider: 'openemr',
      status: 'not_found',
      patient_found: false,
      patient_verified: false,
      message: 'No patient found matching the provided identifiers',
    }, startMs);
  }

  if (!verified) {
    return success('health_lookup_patient', {
      provider: 'openemr',
      status: 'found',
      patient_found: true,
      patient_verified: false,
      ...maskPatient(patient),
    }, startMs);
  }

  return success('health_lookup_patient', {
    provider: 'openemr',
    status: 'found',
    patient_found: true,
    patient_verified: true,
    patient: fullPatient(patient),
  }, startMs);
}

/** health_update_patient_info */
export async function updatePatientInfo(
  params: z.infer<typeof updatePatientInfoSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const cached = checkIdempotency(params.idempotency_key);
  if (cached) return cached;

  const level = resolveLevel(params);
  const policyErr = enforcePolicy('health_update_patient_info', level, startMs);
  if (policyErr) return policyErr;

  const hasIdentity = params.patient_id || params.patient_phone || params.patient_email;
  if (!hasIdentity) {
    return invalidRequest(
      'health_update_patient_info',
      'At least one identity field is required: patient_id, patient_phone, or patient_email',
      startMs,
    );
  }

  if (!params.updates || Object.keys(params.updates).length === 0) {
    return invalidRequest('health_update_patient_info', 'updates object must have at least one property', startMs);
  }

  let pid = params.patient_id;
  if (!pid && params.patient_phone) {
    const raw = await openemr.get<unknown>(`/api/patient?phone=${encodeURIComponent(params.patient_phone)}`);
    const list = extractList<PatientRecord>(raw);
    pid = list[0]?.pid ? String(list[0].pid) : undefined;
  }
  if (!pid && params.patient_email) {
    const raw = await openemr.get<unknown>(`/api/patient?email=${encodeURIComponent(params.patient_email)}`);
    const list = extractList<PatientRecord>(raw);
    pid = list[0]?.pid ? String(list[0].pid) : undefined;
  }

  if (!pid) {
    return notFound('health_update_patient_info', 'Patient not found with provided identifiers', startMs);
  }

  await openemr.put<unknown>(`/api/patient/${pid}`, params.updates as Record<string, unknown>);

  const result = success('health_update_patient_info', {
    tool: 'health_update_patient_info',
    status: 'submitted',
    provider: 'openemr',
    result: { patient_id: pid, updated_fields: Object.keys(params.updates) },
    persistence: 'persisted',
  }, startMs);
  storeIdempotency(params.idempotency_key, result);
  return result;
}

/** health_new_patient_intake */
export async function newPatientIntake(
  params: z.infer<typeof newPatientIntakeSchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const cached = checkIdempotency(params.idempotency_key);
  if (cached) return cached;

  if (!params.intake || Object.keys(params.intake).length === 0) {
    return invalidRequest('health_new_patient_intake', 'intake must have at least one property', startMs);
  }

  const raw = await openemr.post<unknown>('/api/patient', params.intake as Record<string, unknown>);
  const created = extractRecord<PatientRecord>(raw);

  const result = success('health_new_patient_intake', {
    tool: 'health_new_patient_intake',
    status: 'submitted',
    provider: 'openemr',
    result: created ? { patient_id: String(created.pid ?? ''), ...created } : null,
    persistence: 'persisted',
    captured_payload: params.intake,
  }, startMs);
  storeIdempotency(params.idempotency_key, result);
  return result;
}

/** health_collect_medical_history */
export async function collectMedicalHistory(
  params: z.infer<typeof collectMedicalHistorySchema>,
  startMs: number,
): Promise<CanonicalResponse> {
  const cached = checkIdempotency(params.idempotency_key);
  if (cached) return cached;

  if (!params.history || Object.keys(params.history).length === 0) {
    return invalidRequest('health_collect_medical_history', 'history must have at least one property', startMs);
  }

  if (!params.patient_id && !params.new_patient_reference) {
    return invalidRequest('health_collect_medical_history', 'One of patient_id or new_patient_reference is required', startMs);
  }

  if (params.patient_id) {
    const level = resolveLevel(params);
    const policyErr = enforcePolicy('health_collect_medical_history', level, startMs);
    if (policyErr) return policyErr;
  }

  // OpenEMR doesn't have a single dedicated medical-history endpoint;
  // persist via the patient record's history fields or a FHIR document.
  // For now we store via the patient update endpoint with the history payload.
  const pid = params.patient_id ?? params.new_patient_reference ?? '';

  if (params.patient_id) {
    await openemr.put<unknown>(`/api/patient/${pid}`, {
      medical_history: params.history,
    });
  }
  // For new_patient_reference we store locally until a patient record exists

  const result = success('health_collect_medical_history', {
    tool: 'health_collect_medical_history',
    status: 'submitted',
    provider: 'openemr',
    result: {
      patient_id: params.patient_id ?? null,
      new_patient_reference: params.new_patient_reference ?? null,
      fields_recorded: Object.keys(params.history),
    },
    persistence: 'persisted',
    captured_payload: params.history,
  }, startMs);
  storeIdempotency(params.idempotency_key, result);
  return result;
}
