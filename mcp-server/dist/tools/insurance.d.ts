/**
 * Insurance verification tool — canonical name: health_verify_insurance
 *
 * Delegates to the Stedi eligibility API. Requires:
 *   STEDI_API_KEY   env var
 *   STEDI_ENDPOINT  env var (optional, defaults to standard Stedi endpoint)
 *
 * If STEDI_API_KEY is not configured, returns precondition_failed.
 */
import { z } from 'zod';
import { CanonicalResponse } from '../response.js';
export declare const verifyInsuranceSchema: z.ZodObject<{
    stedi_request: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    provider_npi: z.ZodOptional<z.ZodString>;
    member_id: z.ZodOptional<z.ZodString>;
    first_name: z.ZodOptional<z.ZodString>;
    last_name: z.ZodOptional<z.ZodString>;
    date_of_birth: z.ZodOptional<z.ZodString>;
    payer_id: z.ZodOptional<z.ZodString>;
    service_type_codes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    patient_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    patient_id?: string | undefined;
    stedi_request?: Record<string, unknown> | undefined;
    provider_npi?: string | undefined;
    member_id?: string | undefined;
    first_name?: string | undefined;
    last_name?: string | undefined;
    date_of_birth?: string | undefined;
    payer_id?: string | undefined;
    service_type_codes?: string[] | undefined;
}, {
    patient_id?: string | undefined;
    stedi_request?: Record<string, unknown> | undefined;
    provider_npi?: string | undefined;
    member_id?: string | undefined;
    first_name?: string | undefined;
    last_name?: string | undefined;
    date_of_birth?: string | undefined;
    payer_id?: string | undefined;
    service_type_codes?: string[] | undefined;
}>;
export declare function verifyInsurance(params: z.infer<typeof verifyInsuranceSchema>, startMs: number): Promise<CanonicalResponse>;
