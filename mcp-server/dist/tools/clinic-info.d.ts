/**
 * Clinic info tools — canonical names:
 *   health_get_office_hours
 *   health_get_location
 *   health_get_billing_policy
 *   health_get_procedure_catalog
 *
 * OpenEMR REST surface:
 *   GET /api/facility               — location data
 *   GET /api/list/appttype          — appointment/procedure types
 *
 * Office hours and billing policy are config-driven (from environment variables
 * OFFICE_HOURS_JSON and BILLING_POLICY_JSON). If not configured, reasonable
 * defaults or a no-data message is returned.
 */
import { z } from 'zod';
import { CanonicalResponse } from '../response.js';
export declare const getOfficeHoursSchema: z.ZodObject<{
    location_id: z.ZodOptional<z.ZodString>;
    day: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    location_id?: string | undefined;
    day?: string | undefined;
}, {
    location_id?: string | undefined;
    day?: string | undefined;
}>;
export declare const getLocationSchema: z.ZodObject<{
    location_id: z.ZodOptional<z.ZodString>;
    query: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit?: number | undefined;
    location_id?: string | undefined;
    query?: string | undefined;
}, {
    limit?: number | undefined;
    location_id?: string | undefined;
    query?: string | undefined;
}>;
export declare const getBillingPolicySchema: z.ZodObject<{
    topic: z.ZodOptional<z.ZodEnum<["insurance", "copay", "cancellation", "refund", "payment_plan"]>>;
}, "strip", z.ZodTypeAny, {
    topic?: "insurance" | "copay" | "cancellation" | "refund" | "payment_plan" | undefined;
}, {
    topic?: "insurance" | "copay" | "cancellation" | "refund" | "payment_plan" | undefined;
}>;
export declare const getProcedureCatalogSchema: z.ZodObject<{
    procedure_code: z.ZodOptional<z.ZodString>;
    query: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit?: number | undefined;
    query?: string | undefined;
    procedure_code?: string | undefined;
}, {
    limit?: number | undefined;
    query?: string | undefined;
    procedure_code?: string | undefined;
}>;
/** health_get_office_hours */
export declare function getOfficeHours(params: z.infer<typeof getOfficeHoursSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_get_location */
export declare function getLocation(params: z.infer<typeof getLocationSchema>, startMs: number): Promise<CanonicalResponse>;
/** health_get_billing_policy */
export declare function getBillingPolicy(params: z.infer<typeof getBillingPolicySchema>, startMs: number): Promise<CanonicalResponse>;
/** health_get_procedure_catalog */
export declare function getProcedureCatalog(params: z.infer<typeof getProcedureCatalogSchema>, startMs: number): Promise<CanonicalResponse>;
