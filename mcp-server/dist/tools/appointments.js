/**
 * Appointment operation tools — canonical names:
 *   health_check_slots
 *   health_book_slot
 *   health_list_appointments
 *   health_cancel_appointment
 *   health_reschedule_appointment
 *
 * OpenEMR REST surface:
 *   GET  /api/appointment
 *   GET  /api/patient/{pid}/appointment
 *   POST /api/patient/{pid}/appointment
 *   DELETE /api/patient/{pid}/appointment/{eid}
 *   GET  /api/facility
 *   GET  /api/list/appttype
 */
import { z } from 'zod';
import { openemr } from '../openemr-client.js';
import { resolveDate, addMinutes, todayIso } from '../utils/date.js';
import { encodeSlotId, decodeSlotId, encodeBookingRef, decodeBookingRef, } from '../utils/slot.js';
import { success, invalidRequest, notFound, providerError, } from '../response.js';
// ── Schemas ──────────────────────────────────────────────────────────────────
export const checkSlotsSchema = z.object({
    date: z.string().optional().describe('Date (YYYY-MM-DD or natural phrase: today, tomorrow, next monday)'),
    visit_type: z.string().optional().describe('Visit type / appointment category name filter'),
    provider_id: z.string().optional().describe('Provider ID to filter by'),
    timezone: z.string().optional().describe('IANA timezone (e.g. America/Los_Angeles)'),
    duration_minutes: z.number().int().optional().describe('Desired slot duration in minutes (default 30)'),
});
export const bookSlotSchema = z.object({
    slot_id: z.string().describe('Canonical slot ID from health_check_slots'),
    date: z.string().optional().describe('Booking date (YYYY-MM-DD or natural phrase)'),
    start_time: z.string().optional().describe('HH:MM start time (may be derived from slot_id)'),
    end_time: z.string().optional().describe('HH:MM end time'),
    duration_minutes: z.number().int().optional().describe('Duration in minutes (default 30)'),
    patient_name: z.string().optional().describe('Patient full name'),
    patient_phone: z.string().optional().describe('Patient phone number'),
    patient_email: z.string().optional().describe('Patient email address'),
    patient_id: z.string().optional().describe('Canonical patient ID (OpenEMR PID)'),
    patient_verified: z.boolean().optional().describe('Whether patient identity has been verified'),
    reason: z.string().optional().describe('Booking reason / notes'),
    visit_type: z.string().optional().describe('Visit type override'),
    provider_id: z.string().optional().describe('Provider ID override'),
    timezone: z.string().optional().describe('IANA timezone override'),
});
export const listAppointmentsSchema = z.object({
    patient_phone: z.string().optional().describe('Patient phone lookup'),
    patient_email: z.string().optional().describe('Patient email lookup'),
    patient_id: z.string().optional().describe('Patient ID (OpenEMR PID)'),
    patient_verified: z.boolean().optional().describe('Whether patient identity is verified'),
    from_date: z.string().optional().describe('Start date filter (YYYY-MM-DD or natural phrase)'),
    to_date: z.string().optional().describe('End date filter (YYYY-MM-DD or natural phrase)'),
    status: z.string().optional().describe('Status code filter (e.g. "-", "*", "x", "<")'),
    limit: z.number().int().optional().describe('Max results (default 10)'),
});
export const cancelAppointmentSchema = z.object({
    booking_ref: z.string().optional().describe('Booking reference (emr:appt:{eid})'),
    slot_id: z.string().optional().describe('Slot ID (if booking_ref unavailable)'),
    patient_phone: z.string().optional().describe('Patient phone for ownership verification'),
    patient_email: z.string().optional().describe('Patient email for ownership verification'),
    patient_id: z.string().optional().describe('Patient ID for ownership verification'),
    patient_verified: z.boolean().optional().describe('Whether patient identity is verified'),
    cancel_reason: z.string().optional().describe('Cancellation reason'),
});
export const rescheduleAppointmentSchema = z.object({
    booking_ref: z.string().optional().describe('Booking reference of appointment to reschedule'),
    slot_id: z.string().optional().describe('Current slot ID (if booking_ref unavailable)'),
    new_slot_id: z.string().describe('Target slot ID to move appointment to'),
    duration_minutes: z.number().int().optional().describe('Duration override for new slot'),
    patient_phone: z.string().optional().describe('Patient phone for ownership verification'),
    patient_email: z.string().optional().describe('Patient email for ownership verification'),
    patient_id: z.string().optional().describe('Patient ID for ownership verification'),
    patient_name: z.string().optional().describe('Patient name override'),
    patient_verified: z.boolean().optional().describe('Whether patient identity is verified'),
    reason: z.string().optional().describe('Reschedule notes'),
    visit_type: z.string().optional().describe('Visit type override'),
    provider_id: z.string().optional().describe('Provider ID override'),
    timezone: z.string().optional().describe('IANA timezone override'),
});
function extractList(data) {
    if (Array.isArray(data))
        return data;
    if (data && typeof data === 'object' && 'data' in data) {
        const inner = data.data;
        if (Array.isArray(inner))
            return inner;
    }
    return [];
}
function extractRecord(data) {
    if (!data || typeof data !== 'object')
        return null;
    if ('data' in data) {
        const inner = data.data;
        if (Array.isArray(inner) && inner.length > 0)
            return inner[0];
        if (inner && typeof inner === 'object' && !Array.isArray(inner))
            return inner;
    }
    return data;
}
function normalizeAppt(a) {
    const eid = String(a.pc_eid ?? '');
    const durSecs = Number(a.pc_duration ?? 0);
    const endTime = a.pc_endTime ?? addMinutes(a.pc_startTime ?? '00:00', Math.floor(durSecs / 60)) ?? '';
    return {
        slot_id: eid
            ? encodeSlotId({
                date: a.pc_eventDate ?? '',
                startHHmm: (a.pc_startTime ?? '00:00').slice(0, 5),
                facilityId: Number(a.pc_facility ?? 0),
                providerId: Number(a.pc_aid ?? 0),
                catId: Number(a.pc_catid ?? 0),
                durationSecs: durSecs,
            })
            : null,
        booking_ref: eid ? encodeBookingRef(eid) : null,
        appointment_id: eid ? encodeBookingRef(eid) : null,
        date: a.pc_eventDate ?? null,
        start_time: a.pc_startTime ? a.pc_startTime.slice(0, 5) : null,
        end_time: endTime ? String(endTime).slice(0, 5) : null,
        status: a.pc_apptstatus ?? null,
        patient_id: a.pc_pid ? String(a.pc_pid) : null,
        provider_id: a.pc_aid ? String(a.pc_aid) : null,
        title: a.pc_title ?? null,
        notes: a.pc_hometext ?? null,
        facility_id: a.pc_facility ? String(a.pc_facility) : null,
    };
}
/** Look up a patient by phone number. Returns pid or null. */
async function findPatientPid(params) {
    if (params.patient_id)
        return params.patient_id;
    if (params.patient_phone) {
        const raw = await openemr.get(`/api/patient?phone=${encodeURIComponent(params.patient_phone)}`);
        const list = extractList(raw);
        if (list.length > 0)
            return String(list[0].pid ?? '');
    }
    if (params.patient_email) {
        const raw = await openemr.get(`/api/patient?email=${encodeURIComponent(params.patient_email)}`);
        const list = extractList(raw);
        if (list.length > 0)
            return String(list[0].pid ?? '');
    }
    return null;
}
/** Resolve a booking_ref or slot_id to { pid, eid }. */
async function resolveAppointmentRef(bookingRef, slotId, pid) {
    if (bookingRef) {
        const eid = decodeBookingRef(bookingRef);
        if (!eid)
            return null;
        const raw = await openemr.get(`/api/appointment/${eid}`);
        const appt = extractRecord(raw);
        if (!appt)
            return null;
        return { pid: String(appt.pc_pid ?? pid ?? ''), eid };
    }
    if (slotId) {
        // slot_id may represent an existing appointment if the date/time matches
        const parts = decodeSlotId(slotId);
        if (!parts || !pid)
            return null;
        const raw = await openemr.get(`/api/patient/${pid}/appointment`);
        const list = extractList(raw);
        const match = list.find((a) => a.pc_eventDate === parts.date &&
            (a.pc_startTime ?? '').startsWith(parts.startHHmm));
        if (!match || !match.pc_eid)
            return null;
        return { pid, eid: String(match.pc_eid) };
    }
    return null;
}
// ── Handlers ──────────────────────────────────────────────────────────────────
/** health_check_slots */
export async function checkSlots(params, startMs) {
    const date = resolveDate(params.date) ?? todayIso();
    const durationMins = Number.isInteger(params.duration_minutes) && (params.duration_minutes ?? 0) > 0
        ? params.duration_minutes
        : 30;
    // Fetch appointment categories to find valid slot types
    const catRaw = await openemr.get('/api/list/appttype');
    const categories = extractList(catRaw);
    // Fetch facilities for location data
    const facilityRaw = await openemr.get('/api/facility');
    const facilities = extractList(facilityRaw);
    const defaultFacility = facilities[0];
    if (!defaultFacility?.id) {
        return providerError('health_check_slots', 'No facilities configured in OpenEMR', startMs);
    }
    // Fetch existing appointments for the day to avoid conflicts
    const existingRaw = await openemr.get(`/api/appointment`);
    const existing = extractList(existingRaw).filter((a) => a.pc_eventDate === date);
    const bookedTimes = new Set(existing.map((a) => (a.pc_startTime ?? '').slice(0, 5)));
    // Generate available slots within office hours (08:00–17:00)
    const slots = [];
    const officeStart = 8 * 60;
    const officeEnd = 17 * 60;
    // Filter categories by visit_type if provided
    const matchingCats = params.visit_type
        ? categories.filter((c) => (c.pc_catname ?? '').toLowerCase().includes(params.visit_type.toLowerCase()))
        : categories.slice(0, 1); // default to first category
    const cat = matchingCats[0];
    if (!cat) {
        return success('health_check_slots', {
            provider: 'openemr',
            date,
            available_slots: [],
            count: 0,
            message: `No appointment category found matching visit_type "${params.visit_type ?? ''}"`,
        }, startMs);
    }
    const catDurSecs = Number(cat.pc_duration ?? durationMins * 60);
    const slotDurMins = Math.floor(catDurSecs / 60) || durationMins;
    const providerId = params.provider_id ? parseInt(params.provider_id, 10) : 0;
    for (let minuteOfDay = officeStart; minuteOfDay + slotDurMins <= officeEnd; minuteOfDay += slotDurMins) {
        const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
        const mm = String(minuteOfDay % 60).padStart(2, '0');
        const startTime = `${hh}:${mm}`;
        if (bookedTimes.has(startTime))
            continue;
        const endTime = addMinutes(startTime, slotDurMins) ?? '';
        const slotId = encodeSlotId({
            date,
            startHHmm: startTime,
            facilityId: Number(defaultFacility.id),
            providerId,
            catId: Number(cat.pc_catid ?? 0),
            durationSecs: slotDurMins * 60,
        });
        slots.push({
            id: slotId,
            slot_id: slotId,
            date,
            start_time: startTime,
            end_time: endTime,
            provider: params.provider_id ?? null,
            status: 'free',
            visit_type: cat.pc_catname ?? null,
            duration_minutes: slotDurMins,
            location_id: String(defaultFacility.id),
        });
    }
    return success('health_check_slots', {
        provider: 'openemr',
        date,
        available_slots: slots,
        count: slots.length,
        earliest_available_date: slots.length > 0 ? date : null,
    }, startMs);
}
/** health_book_slot */
export async function bookSlot(params, startMs) {
    if (!params.slot_id) {
        return invalidRequest('health_book_slot', 'slot_id is required', startMs);
    }
    const slot = decodeSlotId(params.slot_id);
    if (!slot) {
        return invalidRequest('health_book_slot', `Invalid slot_id: ${params.slot_id}`, startMs);
    }
    // Resolve patient
    const pid = await findPatientPid(params);
    if (!pid) {
        return invalidRequest('health_book_slot', 'Unable to identify patient. Provide patient_id, patient_phone, or patient_email for OpenEMR bookings.', startMs);
    }
    const date = resolveDate(params.date) ?? slot.date;
    const startTime = params.start_time ?? slot.startHHmm;
    const durationSecs = params.duration_minutes
        ? params.duration_minutes * 60
        : slot.durationSecs;
    const endTime = params.end_time ?? addMinutes(startTime, Math.floor(durationSecs / 60)) ?? '';
    const body = {
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
    if (slot.providerId)
        body['pc_aid'] = slot.providerId;
    if (params.provider_id)
        body['pc_aid'] = parseInt(params.provider_id, 10);
    const raw = await openemr.post(`/api/patient/${pid}/appointment`, body);
    const created = extractRecord(raw);
    if (!created?.pc_eid) {
        return providerError('health_book_slot', 'Appointment created but no eid returned', startMs);
    }
    const eid = String(created.pc_eid);
    const bookingRef = encodeBookingRef(eid);
    return success('health_book_slot', {
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
}
/** health_list_appointments */
export async function listAppointments(params, startMs) {
    const limit = params.limit && params.limit > 0 ? params.limit : 10;
    const fromDate = resolveDate(params.from_date);
    const toDate = resolveDate(params.to_date);
    const verified = params.patient_verified ?? false;
    let raw;
    const pid = await findPatientPid(params);
    if (pid) {
        raw = await openemr.get(`/api/patient/${pid}/appointment`);
    }
    else {
        raw = await openemr.get('/api/appointment');
    }
    let appts = extractList(raw);
    if (fromDate)
        appts = appts.filter((a) => (a.pc_eventDate ?? '') >= fromDate);
    if (toDate)
        appts = appts.filter((a) => (a.pc_eventDate ?? '') <= toDate);
    if (params.status)
        appts = appts.filter((a) => a.pc_apptstatus === params.status);
    appts = appts.slice(0, limit);
    const normalized = appts.map(normalizeAppt).map((a) => {
        if (!verified) {
            // Mask PHI fields if unverified
            return { ...a, patient_id: null, notes: null };
        }
        return a;
    });
    return success('health_list_appointments', {
        provider: 'openemr',
        patient_verified: verified,
        appointments: normalized,
        count: normalized.length,
        total_count: normalized.length,
        status_filter: params.status ?? null,
    }, startMs);
}
/** health_cancel_appointment */
export async function cancelAppointment(params, startMs) {
    if (!params.booking_ref && !params.slot_id) {
        return invalidRequest('health_cancel_appointment', 'At least one of booking_ref or slot_id is required', startMs);
    }
    const pid = await findPatientPid(params);
    const ref = await resolveAppointmentRef(params.booking_ref, params.slot_id, pid ?? undefined);
    if (!ref) {
        return notFound('health_cancel_appointment', `Appointment not found for booking_ref=${params.booking_ref ?? params.slot_id}`, startMs);
    }
    // Cancel by updating status to "x" (cancelled) — soft cancel preferred over hard delete
    await openemr.delete(`/api/patient/${ref.pid}/appointment/${ref.eid}`);
    const bookingRef = encodeBookingRef(ref.eid);
    return success('health_cancel_appointment', {
        provider: 'openemr',
        status: 'cancelled',
        booking_ref: bookingRef,
        slot_id: params.booking_ref
            ? null
            : params.slot_id,
        message: `Appointment ${bookingRef} cancelled${params.cancel_reason ? `: ${params.cancel_reason}` : ''}`,
    }, startMs);
}
/** health_reschedule_appointment */
export async function rescheduleAppointment(params, startMs) {
    if (!params.new_slot_id) {
        return invalidRequest('health_reschedule_appointment', 'new_slot_id is required', startMs);
    }
    if (!params.booking_ref && !params.slot_id) {
        return invalidRequest('health_reschedule_appointment', 'At least one of booking_ref or slot_id is required', startMs);
    }
    const newSlot = decodeSlotId(params.new_slot_id);
    if (!newSlot) {
        return invalidRequest('health_reschedule_appointment', `Invalid new_slot_id: ${params.new_slot_id}`, startMs);
    }
    const pid = await findPatientPid(params);
    const ref = await resolveAppointmentRef(params.booking_ref, params.slot_id, pid ?? undefined);
    if (!ref) {
        return notFound('health_reschedule_appointment', `Original appointment not found`, startMs);
    }
    // Fetch original to preserve fields
    const origRaw = await openemr.get(`/api/appointment/${ref.eid}`);
    const orig = extractRecord(origRaw);
    if (!orig) {
        return notFound('health_reschedule_appointment', 'Original appointment record not found', startMs);
    }
    const durationSecs = params.duration_minutes
        ? params.duration_minutes * 60
        : newSlot.durationSecs;
    const endTime = addMinutes(newSlot.startHHmm, Math.floor(durationSecs / 60)) ?? '';
    // Create new appointment at the target slot
    const newBody = {
        pc_catid: newSlot.catId || orig.pc_catid,
        pc_title: params.visit_type ?? orig.pc_title ?? 'Office Visit',
        pc_eventDate: newSlot.date,
        pc_startTime: newSlot.startHHmm,
        pc_endTime: endTime,
        pc_duration: durationSecs,
        pc_hometext: params.reason ?? orig.pc_hometext ?? '',
        pc_apptstatus: '-',
        pc_facility: newSlot.facilityId || orig.pc_facility,
        pc_billing_location: newSlot.facilityId || orig.pc_billing_location,
    };
    const providerIdOverride = params.provider_id
        ? parseInt(params.provider_id, 10)
        : (newSlot.providerId || orig.pc_aid);
    if (providerIdOverride)
        newBody['pc_aid'] = providerIdOverride;
    const newRaw = await openemr.post(`/api/patient/${ref.pid}/appointment`, newBody);
    const newAppt = extractRecord(newRaw);
    if (!newAppt?.pc_eid) {
        return providerError('health_reschedule_appointment', 'New appointment created but no eid returned', startMs);
    }
    // Delete original
    await openemr.delete(`/api/patient/${ref.pid}/appointment/${ref.eid}`);
    const prevRef = encodeBookingRef(ref.eid);
    const newRef = encodeBookingRef(String(newAppt.pc_eid));
    return success('health_reschedule_appointment', {
        provider: 'openemr',
        status: 'rescheduled',
        new_slot_id: params.new_slot_id,
        previous_booking_ref: prevRef,
        previous_slot_id: params.slot_id ?? null,
        new_confirmation_id: newRef,
        confirmation_id: newRef,
        message: `Appointment rescheduled to ${newSlot.date} at ${newSlot.startHHmm}`,
    }, startMs);
}
