/**
 * Appointment operation tools:
 *   health_check_slots
 *   health_hold_slot          ← NEW: reserve a slot for a short TTL
 *   health_confirm_booking    ← NEW: commit a hold into an OpenEMR appointment
 *   health_book_slot          (direct booking, for simple cases)
 *   health_list_appointments
 *   health_cancel_appointment
 *   health_reschedule_appointment
 */

import { z } from 'zod';
import { openemr } from '../openemr-client.js';
import { resolveDate, addMinutes, todayIso } from '../utils/date.js';
import { encodeSlotId, decodeSlotId, encodeBookingRef, decodeBookingRef } from '../utils/slot.js';
import { CanonicalResponse, success, invalidRequest, notFound, providerError, slotUnavailable } from '../response.js';
import { checkIdempotency, storeIdempotency } from '../middleware/idempotency.js';
import { resolveLevel, enforcePolicy } from '../middleware/policy.js';
import { createHold, getHold, releaseHold, tryLockSlot, unlockSlot } from '../middleware/holds.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

export const checkSlotsSchema = z.object({
  date: z.string().optional().describe('Date (YYYY-MM-DD or: today, tomorrow, next monday)'),
  visit_type: z.string().optional().describe('Appointment category name filter'),
  provider_id: z.string().optional().describe('Provider ID filter'),
  timezone: z.string().optional().describe('IANA timezone (e.g. America/Los_Angeles)'),
  duration_minutes: z.number().int().optional().describe('Desired duration in minutes (default 30)'),
});

export const holdSlotSchema = z.object({
  slot_id: z.string().describe('Slot ID from health_check_slots'),
  patient_id: z.string().optional().describe('Patient ID (OpenEMR PID)'),
  patient_phone: z.string().optional().describe('Patient phone for lookup'),
  patient_email: z.string().optional().describe('Patient email for lookup'),
  patient_verified: z.boolean().optional(),
  verification_level: z.enum(['none', 'basic', 'contact', 'strong']).optional()
    .describe('Verification level (supersedes patient_verified)'),
  reason: z.string().optional().describe('Appointment reason / notes'),
  visit_type: z.string().optional().describe('Visit type override'),
  duration_minutes: z.number().int().optional().describe('Duration override in minutes'),
});

export const confirmBookingSchema = z.object({
  hold_id: z.string().describe('Hold ID from health_hold_slot'),
  idempotency_key: z.string().describe('Unique key for safe retry — required for commit'),
  patient_verified: z.boolean().optional(),
  verification_level: z.enum(['none', 'basic', 'contact', 'strong']).optional()
    .describe('Verification level for policy check'),
  reason: z.string().optional().describe('Override reason/notes'),
  provider_id: z.string().optional().describe('Provider ID override'),
  visit_type: z.string().optional().describe('Visit type override'),
});

export const bookSlotSchema = z.object({
  slot_id: z.string().describe('Slot ID from health_check_slots'),
  idempotency_key: z.string().optional().describe('Unique key for safe retry'),
  date: z.string().optional(),
  start_time: z.string().optional().describe('HH:MM start time'),
  end_time: z.string().optional().describe('HH:MM end time'),
  duration_minutes: z.number().int().optional(),
  patient_name: z.string().optional(),
  patient_phone: z.string().optional(),
  patient_email: z.string().optional(),
  patient_id: z.string().optional(),
  patient_verified: z.boolean().optional(),
  verification_level: z.enum(['none', 'basic', 'contact', 'strong']).optional(),
  reason: z.string().optional(),
  visit_type: z.string().optional(),
  provider_id: z.string().optional(),
  timezone: z.string().optional(),
});

export const listAppointmentsSchema = z.object({
  patient_phone: z.string().optional(),
  patient_email: z.string().optional(),
  patient_id: z.string().optional(),
  patient_verified: z.boolean().optional(),
  verification_level: z.enum(['none', 'basic', 'contact', 'strong']).optional(),
  from_date: z.string().optional().describe('YYYY-MM-DD or natural phrase'),
  to_date: z.string().optional().describe('YYYY-MM-DD or natural phrase'),
  status: z.string().optional().describe('Status code filter (e.g. "-", "*", "x")'),
  limit: z.number().int().optional().describe('Max results (default 10)'),
});

export const cancelAppointmentSchema = z.object({
  booking_ref: z.string().optional().describe('Booking reference (emr:appt:{eid})'),
  slot_id: z.string().optional().describe('Slot ID if booking_ref unavailable'),
  idempotency_key: z.string().optional().describe('Unique key for safe retry'),
  patient_phone: z.string().optional(),
  patient_email: z.string().optional(),
  patient_id: z.string().optional(),
  patient_verified: z.boolean().optional(),
  verification_level: z.enum(['none', 'basic', 'contact', 'strong']).optional(),
  cancel_reason: z.string().optional(),
});

export const rescheduleAppointmentSchema = z.object({
  booking_ref: z.string().optional(),
  slot_id: z.string().optional(),
  new_slot_id: z.string().describe('Target slot to move appointment to'),
  idempotency_key: z.string().optional().describe('Unique key for safe retry'),
  duration_minutes: z.number().int().optional(),
  patient_phone: z.string().optional(),
  patient_email: z.string().optional(),
  patient_id: z.string().optional(),
  patient_name: z.string().optional(),
  patient_verified: z.boolean().optional(),
  verification_level: z.enum(['none', 'basic', 'contact', 'strong']).optional(),
  reason: z.string().optional(),
  visit_type: z.string().optional(),
  provider_id: z.string().optional(),
  timezone: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ApptRecord {
  pc_eid?: string | number;
  pc_pid?: string;
  pc_aid?: string;
  pc_catid?: string | number;
  pc_title?: string;
  pc_eventDate?: string;
  pc_startTime?: string;
  pc_endTime?: string;
  pc_duration?: string | number;
  pc_apptstatus?: string;
  pc_hometext?: string;
  pc_facility?: string | number;
  pc_billing_location?: string | number;
  [key: string]: unknown;
}

interface FacilityRecord { id?: string | number; name?: string; [key: string]: unknown; }
interface CategoryRecord { pc_catid?: string | number; pc_catname?: string; pc_duration?: string | number; [key: string]: unknown; }

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

function normalizeAppt(a: ApptRecord): Record<string, unknown> {
  const eid = String(a.pc_eid ?? '');
  const durSecs = Number(a.pc_duration ?? 0);
  const endTime = a.pc_endTime ?? addMinutes((a.pc_startTime ?? '00:00').slice(0, 5), Math.floor(durSecs / 60)) ?? '';
  return {
    slot_id: eid ? encodeSlotId({ date: a.pc_eventDate ?? '', startHHmm: (a.pc_startTime ?? '00:00').slice(0, 5), facilityId: Number(a.pc_facility ?? 0), providerId: Number(a.pc_aid ?? 0), catId: Number(a.pc_catid ?? 0), durationSecs: durSecs }) : null,
    booking_ref: eid ? encodeBookingRef(eid) : null,
    appointment_id: eid ? encodeBookingRef(eid) : null,
    date: a.pc_eventDate ?? null,
    start_time: a.pc_startTime ? a.pc_startTime.slice(0, 5) : null,
    end_time: String(endTime).slice(0, 5) || null,
    status: a.pc_apptstatus ?? null,
    patient_id: a.pc_pid ? String(a.pc_pid) : null,
    provider_id: a.pc_aid ? String(a.pc_aid) : null,
    title: a.pc_title ?? null,
    notes: a.pc_hometext ?? null,
    facility_id: a.pc_facility ? String(a.pc_facility) : null,
  };
}

async function findPatientPid(params: { patient_id?: string; patient_phone?: string; patient_email?: string }): Promise<string | null> {
  if (params.patient_id) return params.patient_id;
  if (params.patient_phone) {
    const raw = await openemr.get<unknown>(`/api/patient?phone=${encodeURIComponent(params.patient_phone)}`);
    const list = extractList<{ pid?: string | number }>(raw);
    if (list.length > 0) return String(list[0].pid ?? '');
  }
  if (params.patient_email) {
    const raw = await openemr.get<unknown>(`/api/patient?email=${encodeURIComponent(params.patient_email)}`);
    const list = extractList<{ pid?: string | number }>(raw);
    if (list.length > 0) return String(list[0].pid ?? '');
  }
  return null;
}

async function resolveAppointmentRef(bookingRef: string | undefined, slotId: string | undefined, pid?: string): Promise<{ pid: string; eid: string } | null> {
  if (bookingRef) {
    const eid = decodeBookingRef(bookingRef);
    if (!eid) return null;
    const raw = await openemr.get<unknown>(`/api/appointment/${eid}`);
    const appt = extractRecord<ApptRecord>(raw);
    if (!appt) return null;
    return { pid: String(appt.pc_pid ?? pid ?? ''), eid };
  }
  if (slotId && pid) {
    const parts = decodeSlotId(slotId);
    if (!parts) return null;
    const raw = await openemr.get<unknown>(`/api/patient/${pid}/appointment`);
    const list = extractList<ApptRecord>(raw);
    const match = list.find((a) => a.pc_eventDate === parts.date && (a.pc_startTime ?? '').startsWith(parts.startHHmm));
    if (!match?.pc_eid) return null;
    return { pid, eid: String(match.pc_eid) };
  }
  return null;
}

async function createOpenEMRAppointment(pid: string, body: Record<string, unknown>): Promise<ApptRecord> {
  const raw = await openemr.post<unknown>(`/api/patient/${pid}/appointment`, body);
  const created = extractRecord<ApptRecord>(raw);
  if (!created?.pc_eid) throw new Error('Appointment created but no eid returned');
  return created;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function checkSlots(params: z.infer<typeof checkSlotsSchema>, startMs: number): Promise<CanonicalResponse> {
  const date = resolveDate(params.date) ?? todayIso();
  const durationMins = (params.duration_minutes ?? 0) > 0 ? params.duration_minutes! : 30;

  const [catRaw, facilityRaw, existingRaw] = await Promise.all([
    openemr.get<unknown>('/api/list/appttype'),
    openemr.get<unknown>('/api/facility'),
    openemr.get<unknown>('/api/appointment'),
  ]);

  const categories = extractList<CategoryRecord>(catRaw);
  const facilities = extractList<FacilityRecord>(facilityRaw);
  const defaultFacility = facilities[0];

  if (!defaultFacility?.id) return providerError('health_check_slots', 'No facilities configured in OpenEMR', startMs);

  const bookedTimes = new Set(
    extractList<ApptRecord>(existingRaw)
      .filter((a) => a.pc_eventDate === date)
      .map((a) => (a.pc_startTime ?? '').slice(0, 5)),
  );

  const matchingCats = params.visit_type
    ? categories.filter((c) => (c.pc_catname ?? '').toLowerCase().includes(params.visit_type!.toLowerCase()))
    : categories.slice(0, 1);
  const cat = matchingCats[0];
  if (!cat) {
    return success('health_check_slots', { provider: 'openemr', date, available_slots: [], count: 0, message: `No category matching "${params.visit_type ?? ''}"` }, startMs);
  }

  const catDurSecs = Number(cat.pc_duration ?? durationMins * 60);
  const slotDurMins = Math.floor(catDurSecs / 60) || durationMins;
  const providerId = params.provider_id ? parseInt(params.provider_id, 10) : 0;
  const slots: Record<string, unknown>[] = [];

  for (let min = 8 * 60; min + slotDurMins <= 17 * 60; min += slotDurMins) {
    const hh = String(Math.floor(min / 60)).padStart(2, '0');
    const mm = String(min % 60).padStart(2, '0');
    const startTime = `${hh}:${mm}`;
    if (bookedTimes.has(startTime)) continue;
    const slotId = encodeSlotId({ date, startHHmm: startTime, facilityId: Number(defaultFacility.id), providerId, catId: Number(cat.pc_catid ?? 0), durationSecs: slotDurMins * 60 });
    slots.push({ id: slotId, slot_id: slotId, date, start_time: startTime, end_time: addMinutes(startTime, slotDurMins) ?? '', provider: params.provider_id ?? null, status: 'free', visit_type: cat.pc_catname ?? null, duration_minutes: slotDurMins, location_id: String(defaultFacility.id) });
  }

  return success('health_check_slots', { provider: 'openemr', date, available_slots: slots, count: slots.length, earliest_available_date: slots.length > 0 ? date : null }, startMs);
}

export async function holdSlot(params: z.infer<typeof holdSlotSchema>, startMs: number): Promise<CanonicalResponse> {
  const slot = decodeSlotId(params.slot_id);
  if (!slot) return invalidRequest('health_hold_slot', `Invalid slot_id: ${params.slot_id}`, startMs);

  const pid = await findPatientPid(params);
  if (!pid) return invalidRequest('health_hold_slot', 'Provide patient_id, patient_phone, or patient_email', startMs);

  const hold = createHold(params.slot_id, pid, slot, {
    reason: params.reason,
    visit_type: params.visit_type,
    duration_minutes: params.duration_minutes,
  });

  return success('health_hold_slot', {
    provider: 'openemr',
    status: 'held',
    hold_id: hold.hold_id,
    slot_id: params.slot_id,
    patient_id: pid,
    date: slot.date,
    start_time: slot.startHHmm,
    expires_at: new Date(hold.expires_at).toISOString(),
    message: `Slot held until ${new Date(hold.expires_at).toISOString()}. Call health_confirm_booking with hold_id to commit.`,
  }, startMs);
}

export async function confirmBooking(params: z.infer<typeof confirmBookingSchema>, startMs: number): Promise<CanonicalResponse> {
  // Idempotency first — must be provided for commit
  const cached = checkIdempotency(params.idempotency_key);
  if (cached) return cached;

  // Policy
  const level = resolveLevel(params);
  const policyErr = enforcePolicy('health_confirm_booking', level, startMs);
  if (policyErr) return policyErr;

  const hold = getHold(params.hold_id);
  if (!hold) return notFound('health_confirm_booking', `Hold ${params.hold_id} not found or expired`, startMs);

  // Per-slot lock prevents double-booking on a single instance
  if (!tryLockSlot(hold.slot_id)) {
    return slotUnavailable('health_confirm_booking', startMs);
  }

  try {
    const slot = hold.slot_parts;
    const durationSecs = hold.duration_minutes ? hold.duration_minutes * 60 : slot.durationSecs;
    const endTime = addMinutes(slot.startHHmm, Math.floor(durationSecs / 60)) ?? '';
    const body: Record<string, unknown> = {
      pc_catid: slot.catId,
      pc_title: params.visit_type ?? hold.visit_type ?? 'Office Visit',
      pc_eventDate: slot.date,
      pc_startTime: slot.startHHmm,
      pc_endTime: endTime,
      pc_duration: durationSecs,
      pc_hometext: params.reason ?? hold.reason ?? '',
      pc_apptstatus: '-',
      pc_facility: slot.facilityId,
      pc_billing_location: slot.facilityId,
    };
    const provId = params.provider_id ? parseInt(params.provider_id, 10) : slot.providerId;
    if (provId) body['pc_aid'] = provId;

    const created = await createOpenEMRAppointment(hold.pid, body);
    releaseHold(params.hold_id);

    const bookingRef = encodeBookingRef(String(created.pc_eid));
    const result = success('health_confirm_booking', {
      provider: 'openemr',
      status: 'confirmed',
      slot_id: hold.slot_id,
      confirmation_id: bookingRef,
      booking_ref: bookingRef,
      appointment_id: bookingRef,
      date: slot.date,
      patient_id: hold.pid,
      message: `Appointment confirmed for ${slot.date} at ${slot.startHHmm}`,
    }, startMs);

    storeIdempotency(params.idempotency_key, result);
    return result;

  } catch (err) {
    unlockSlot(hold.slot_id);
    throw err; // re-thrown — withCanonical maps OpenEMRError
  }
}

export async function bookSlot(params: z.infer<typeof bookSlotSchema>, startMs: number): Promise<CanonicalResponse> {
  // Idempotency
  const cached = checkIdempotency(params.idempotency_key);
  if (cached) return cached;

  if (!params.slot_id) return invalidRequest('health_book_slot', 'slot_id is required', startMs);

  const slot = decodeSlotId(params.slot_id);
  if (!slot) return invalidRequest('health_book_slot', `Invalid slot_id: ${params.slot_id}`, startMs);

  const pid = await findPatientPid(params);
  if (!pid) return invalidRequest('health_book_slot', 'Provide patient_id, patient_phone, or patient_email', startMs);

  const date = resolveDate(params.date) ?? slot.date;
  const startTime = params.start_time ?? slot.startHHmm;
  const durationSecs = params.duration_minutes ? params.duration_minutes * 60 : slot.durationSecs;
  const endTime = params.end_time ?? addMinutes(startTime, Math.floor(durationSecs / 60)) ?? '';

  const body: Record<string, unknown> = {
    pc_catid: slot.catId,
    pc_title: params.visit_type ?? params.reason ?? 'Office Visit',
    pc_eventDate: date,
    pc_startTime: startTime,
    pc_endTime: endTime,
    pc_duration: durationSecs,
    pc_hometext: params.reason ?? '',
    pc_apptstatus: '-',
    pc_facility: slot.facilityId,
    pc_billing_location: slot.facilityId,
  };
  const provId = params.provider_id ? parseInt(params.provider_id, 10) : slot.providerId;
  if (provId) body['pc_aid'] = provId;

  const created = await createOpenEMRAppointment(pid, body);
  const bookingRef = encodeBookingRef(String(created.pc_eid));

  const result = success('health_book_slot', {
    provider: 'openemr',
    status: 'confirmed',
    slot_id: params.slot_id,
    confirmation_id: bookingRef,
    booking_ref: bookingRef,
    appointment_id: bookingRef,
    date,
    patient_id: pid,
    message: `Appointment booked on ${date} at ${startTime}`,
  }, startMs);

  storeIdempotency(params.idempotency_key, result);
  return result;
}

export async function listAppointments(params: z.infer<typeof listAppointmentsSchema>, startMs: number): Promise<CanonicalResponse> {
  const limit = (params.limit ?? 0) > 0 ? params.limit! : 10;
  const fromDate = resolveDate(params.from_date);
  const toDate = resolveDate(params.to_date);
  const level = resolveLevel(params);
  const verified = level !== 'none';

  const pid = await findPatientPid(params);
  const raw = pid
    ? await openemr.get<unknown>(`/api/patient/${pid}/appointment`)
    : await openemr.get<unknown>('/api/appointment');

  let appts = extractList<ApptRecord>(raw);
  if (fromDate) appts = appts.filter((a) => String(a.pc_eventDate ?? '') >= fromDate);
  if (toDate) appts = appts.filter((a) => String(a.pc_eventDate ?? '') <= toDate);
  if (params.status) appts = appts.filter((a) => a.pc_apptstatus === params.status);
  appts = appts.slice(0, limit);

  const normalized = appts.map(normalizeAppt).map((a) =>
    verified ? a : { ...a, patient_id: null, notes: null },
  );

  return success('health_list_appointments', {
    provider: 'openemr',
    patient_verified: verified,
    appointments: normalized,
    count: normalized.length,
    total_count: normalized.length,
    status_filter: params.status ?? null,
    verification_hint: verified ? null : 'Set verification_level to "basic" or higher to see full patient data',
  }, startMs);
}

export async function cancelAppointment(params: z.infer<typeof cancelAppointmentSchema>, startMs: number): Promise<CanonicalResponse> {
  if (!params.booking_ref && !params.slot_id) {
    return invalidRequest('health_cancel_appointment', 'At least one of booking_ref or slot_id is required', startMs);
  }

  // Idempotency
  const cached = checkIdempotency(params.idempotency_key);
  if (cached) return cached;

  // Policy: cancel requires contact-level verification
  const level = resolveLevel(params);
  const policyErr = enforcePolicy('health_cancel_appointment', level, startMs);
  if (policyErr) return policyErr;

  const pid = await findPatientPid(params);
  const ref = await resolveAppointmentRef(params.booking_ref, params.slot_id, pid ?? undefined);
  if (!ref) return notFound('health_cancel_appointment', `Appointment not found for ${params.booking_ref ?? params.slot_id}`, startMs);

  await openemr.delete<unknown>(`/api/patient/${ref.pid}/appointment/${ref.eid}`);
  const bookingRef = encodeBookingRef(ref.eid);

  const result = success('health_cancel_appointment', {
    provider: 'openemr',
    status: 'cancelled',
    booking_ref: bookingRef,
    slot_id: params.slot_id ?? null,
    message: `Appointment ${bookingRef} cancelled${params.cancel_reason ? `: ${params.cancel_reason}` : ''}`,
  }, startMs);

  storeIdempotency(params.idempotency_key, result);
  return result;
}

export async function rescheduleAppointment(params: z.infer<typeof rescheduleAppointmentSchema>, startMs: number): Promise<CanonicalResponse> {
  if (!params.new_slot_id) return invalidRequest('health_reschedule_appointment', 'new_slot_id is required', startMs);
  if (!params.booking_ref && !params.slot_id) return invalidRequest('health_reschedule_appointment', 'At least one of booking_ref or slot_id is required', startMs);

  // Idempotency
  const cached = checkIdempotency(params.idempotency_key);
  if (cached) return cached;

  // Policy
  const level = resolveLevel(params);
  const policyErr = enforcePolicy('health_reschedule_appointment', level, startMs);
  if (policyErr) return policyErr;

  const newSlot = decodeSlotId(params.new_slot_id);
  if (!newSlot) return invalidRequest('health_reschedule_appointment', `Invalid new_slot_id: ${params.new_slot_id}`, startMs);

  const pid = await findPatientPid(params);
  const ref = await resolveAppointmentRef(params.booking_ref, params.slot_id, pid ?? undefined);
  if (!ref) return notFound('health_reschedule_appointment', 'Original appointment not found', startMs);

  const origRaw = await openemr.get<unknown>(`/api/appointment/${ref.eid}`);
  const orig = extractRecord<ApptRecord>(origRaw);
  if (!orig) return notFound('health_reschedule_appointment', 'Original appointment record not found', startMs);

  // Lock the new slot to prevent double-booking
  if (!tryLockSlot(params.new_slot_id)) return slotUnavailable('health_reschedule_appointment', startMs);

  try {
    const durationSecs = params.duration_minutes ? params.duration_minutes * 60 : newSlot.durationSecs;
    const body: Record<string, unknown> = {
      pc_catid: newSlot.catId || orig.pc_catid,
      pc_title: params.visit_type ?? orig.pc_title ?? 'Office Visit',
      pc_eventDate: newSlot.date,
      pc_startTime: newSlot.startHHmm,
      pc_endTime: addMinutes(newSlot.startHHmm, Math.floor(durationSecs / 60)) ?? '',
      pc_duration: durationSecs,
      pc_hometext: params.reason ?? orig.pc_hometext ?? '',
      pc_apptstatus: '-',
      pc_facility: newSlot.facilityId || orig.pc_facility,
      pc_billing_location: newSlot.facilityId || orig.pc_billing_location,
    };
    const provId = params.provider_id ? parseInt(params.provider_id, 10) : (newSlot.providerId || orig.pc_aid);
    if (provId) body['pc_aid'] = provId;

    const newAppt = await createOpenEMRAppointment(ref.pid, body);
    await openemr.delete<unknown>(`/api/patient/${ref.pid}/appointment/${ref.eid}`);
    unlockSlot(params.new_slot_id);

    const prevRef = encodeBookingRef(ref.eid);
    const newRef = encodeBookingRef(String(newAppt.pc_eid));

    const result = success('health_reschedule_appointment', {
      provider: 'openemr',
      status: 'rescheduled',
      new_slot_id: params.new_slot_id,
      previous_booking_ref: prevRef,
      previous_slot_id: params.slot_id ?? null,
      new_confirmation_id: newRef,
      confirmation_id: newRef,
      message: `Rescheduled to ${newSlot.date} at ${newSlot.startHHmm}`,
    }, startMs);

    storeIdempotency(params.idempotency_key, result);
    return result;

  } catch (err) {
    unlockSlot(params.new_slot_id);
    throw err;
  }
}
