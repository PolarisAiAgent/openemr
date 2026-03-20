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
import { CanonicalResponse } from '../response.js';
export declare const checkSlotsSchema: z.ZodObject<{
    date: z.ZodOptional<z.ZodString>;
    visit_type: z.ZodOptional<z.ZodString>;
    provider_id: z.ZodOptional<z.ZodString>;
    timezone: z.ZodOptional<z.ZodString>;
    duration_minutes: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    date?: string | undefined;
    visit_type?: string | undefined;
    provider_id?: string | undefined;
    timezone?: string | undefined;
    duration_minutes?: number | undefined;
}, {
    date?: string | undefined;
    visit_type?: string | undefined;
    provider_id?: string | undefined;
    timezone?: string | undefined;
    duration_minutes?: number | undefined;
}>;
export declare const bookSlotSchema: z.ZodObject<{
    slot_id: z.ZodString;
    date: z.ZodOptional<z.ZodString>;
    start_time: z.ZodOptional<z.ZodString>;
    end_time: z.ZodOptional<z.ZodString>;
    duration_minutes: z.ZodOptional<z.ZodNumber>;
    patient_name: z.ZodOptional<z.ZodString>;
    patient_phone: z.ZodOptional<z.ZodString>;
    patient_email: z.ZodOptional<z.ZodString>;
    patient_id: z.ZodOptional<z.ZodString>;
    patient_verified: z.ZodOptional<z.ZodBoolean>;
    reason: z.ZodOptional<z.ZodString>;
    visit_type: z.ZodOptional<z.ZodString>;
    provider_id: z.ZodOptional<z.ZodString>;
    timezone: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    slot_id: string;
    date?: string | undefined;
    visit_type?: string | undefined;
    provider_id?: string | undefined;
    timezone?: string | undefined;
    duration_minutes?: number | undefined;
    start_time?: string | undefined;
    end_time?: string | undefined;
    patient_name?: string | undefined;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    reason?: string | undefined;
}, {
    slot_id: string;
    date?: string | undefined;
    visit_type?: string | undefined;
    provider_id?: string | undefined;
    timezone?: string | undefined;
    duration_minutes?: number | undefined;
    start_time?: string | undefined;
    end_time?: string | undefined;
    patient_name?: string | undefined;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    reason?: string | undefined;
}>;
export declare const listAppointmentsSchema: z.ZodObject<{
    patient_phone: z.ZodOptional<z.ZodString>;
    patient_email: z.ZodOptional<z.ZodString>;
    patient_id: z.ZodOptional<z.ZodString>;
    patient_verified: z.ZodOptional<z.ZodBoolean>;
    from_date: z.ZodOptional<z.ZodString>;
    to_date: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    status?: string | undefined;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    from_date?: string | undefined;
    to_date?: string | undefined;
    limit?: number | undefined;
}, {
    status?: string | undefined;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    from_date?: string | undefined;
    to_date?: string | undefined;
    limit?: number | undefined;
}>;
export declare const cancelAppointmentSchema: z.ZodObject<{
    booking_ref: z.ZodOptional<z.ZodString>;
    slot_id: z.ZodOptional<z.ZodString>;
    patient_phone: z.ZodOptional<z.ZodString>;
    patient_email: z.ZodOptional<z.ZodString>;
    patient_id: z.ZodOptional<z.ZodString>;
    patient_verified: z.ZodOptional<z.ZodBoolean>;
    cancel_reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    slot_id?: string | undefined;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    booking_ref?: string | undefined;
    cancel_reason?: string | undefined;
}, {
    slot_id?: string | undefined;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    booking_ref?: string | undefined;
    cancel_reason?: string | undefined;
}>;
export declare const rescheduleAppointmentSchema: z.ZodObject<{
    booking_ref: z.ZodOptional<z.ZodString>;
    slot_id: z.ZodOptional<z.ZodString>;
    new_slot_id: z.ZodString;
    duration_minutes: z.ZodOptional<z.ZodNumber>;
    patient_phone: z.ZodOptional<z.ZodString>;
    patient_email: z.ZodOptional<z.ZodString>;
    patient_id: z.ZodOptional<z.ZodString>;
    patient_name: z.ZodOptional<z.ZodString>;
    patient_verified: z.ZodOptional<z.ZodBoolean>;
    reason: z.ZodOptional<z.ZodString>;
    visit_type: z.ZodOptional<z.ZodString>;
    provider_id: z.ZodOptional<z.ZodString>;
    timezone: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    new_slot_id: string;
    visit_type?: string | undefined;
    provider_id?: string | undefined;
    timezone?: string | undefined;
    duration_minutes?: number | undefined;
    slot_id?: string | undefined;
    patient_name?: string | undefined;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    reason?: string | undefined;
    booking_ref?: string | undefined;
}, {
    new_slot_id: string;
    visit_type?: string | undefined;
    provider_id?: string | undefined;
    timezone?: string | undefined;
    duration_minutes?: number | undefined;
    slot_id?: string | undefined;
    patient_name?: string | undefined;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    reason?: string | undefined;
    booking_ref?: string | undefined;
}>;
/** health_check_slots */
export declare function checkSlots(params: z.infer<typeof checkSlotsSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_book_slot */
export declare function bookSlot(params: z.infer<typeof bookSlotSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_list_appointments */
export declare function listAppointments(params: z.infer<typeof listAppointmentsSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_cancel_appointment */
export declare function cancelAppointment(params: z.infer<typeof cancelAppointmentSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_reschedule_appointment */
export declare function rescheduleAppointment(params: z.infer<typeof rescheduleAppointmentSchema>, startMs: number): Promise<CanonicalResponse>;
