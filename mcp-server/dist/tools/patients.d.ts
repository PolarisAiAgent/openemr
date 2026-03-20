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
import { CanonicalResponse } from '../response.js';
export declare const lookupPatientSchema: z.ZodObject<{
    patient_phone: z.ZodOptional<z.ZodString>;
    patient_email: z.ZodOptional<z.ZodString>;
    patient_id: z.ZodOptional<z.ZodString>;
    patient_verified: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
}, {
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
}>;
export declare const updatePatientInfoSchema: z.ZodObject<{
    patient_id: z.ZodOptional<z.ZodString>;
    patient_phone: z.ZodOptional<z.ZodString>;
    patient_email: z.ZodOptional<z.ZodString>;
    patient_verified: z.ZodBoolean;
    updates: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    patient_verified: boolean;
    updates: Record<string, unknown>;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
}, {
    patient_verified: boolean;
    updates: Record<string, unknown>;
    patient_phone?: string | undefined;
    patient_email?: string | undefined;
    patient_id?: string | undefined;
}>;
export declare const newPatientIntakeSchema: z.ZodObject<{
    intake: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    source: z.ZodOptional<z.ZodEnum<["voice", "web", "chat", "agent", "unknown"]>>;
}, "strip", z.ZodTypeAny, {
    intake: Record<string, unknown>;
    source?: "voice" | "web" | "chat" | "agent" | "unknown" | undefined;
}, {
    intake: Record<string, unknown>;
    source?: "voice" | "web" | "chat" | "agent" | "unknown" | undefined;
}>;
export declare const collectMedicalHistorySchema: z.ZodObject<{
    history: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    patient_id: z.ZodOptional<z.ZodString>;
    new_patient_reference: z.ZodOptional<z.ZodString>;
    patient_verified: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    history: Record<string, unknown>;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    new_patient_reference?: string | undefined;
}, {
    history: Record<string, unknown>;
    patient_id?: string | undefined;
    patient_verified?: boolean | undefined;
    new_patient_reference?: string | undefined;
}>;
/** health_lookup_patient */
export declare function lookupPatient(params: z.infer<typeof lookupPatientSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_update_patient_info */
export declare function updatePatientInfo(params: z.infer<typeof updatePatientInfoSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_new_patient_intake */
export declare function newPatientIntake(params: z.infer<typeof newPatientIntakeSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_collect_medical_history */
export declare function collectMedicalHistory(params: z.infer<typeof collectMedicalHistorySchema>, startMs: number): Promise<CanonicalResponse>;
