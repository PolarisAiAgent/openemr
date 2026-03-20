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
import { success, invalidRequest, preconditionFailed, providerError, } from '../response.js';
// ── Schema ────────────────────────────────────────────────────────────────────
export const verifyInsuranceSchema = z.object({
    stedi_request: z.record(z.unknown()).optional().describe('Full override request object to forward directly to Stedi'),
    provider_npi: z.string().optional().describe('Provider NPI (required when stedi_request is absent)'),
    member_id: z.string().optional().describe('Insurance member ID (required when stedi_request is absent)'),
    first_name: z.string().optional().describe('Patient first name (required when stedi_request is absent)'),
    last_name: z.string().optional().describe('Patient last name (required when stedi_request is absent)'),
    date_of_birth: z.string().optional().describe('Patient DOB YYYY-MM-DD (required when stedi_request is absent)'),
    payer_id: z.string().optional().describe('Payer routing ID'),
    service_type_codes: z.array(z.string()).optional().describe('Service type codes (default ["30"])'),
    patient_id: z.string().optional().describe('OpenEMR patient ID for local linkage'),
});
// ── Handler ───────────────────────────────────────────────────────────────────
export async function verifyInsurance(params, startMs) {
    const apiKey = process.env['STEDI_API_KEY'];
    const endpoint = process.env['STEDI_ENDPOINT'] ??
        'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3';
    if (!apiKey) {
        return preconditionFailed('health_verify_insurance', 'STEDI_API_KEY is not configured. Set this environment variable to enable insurance verification.', startMs);
    }
    // Build request body
    let body;
    if (params.stedi_request) {
        body = params.stedi_request;
    }
    else {
        // Validate minimum required fields
        const missing = [];
        if (!params.provider_npi)
            missing.push('provider_npi');
        if (!params.member_id)
            missing.push('member_id');
        if (!params.first_name)
            missing.push('first_name');
        if (!params.last_name)
            missing.push('last_name');
        if (!params.date_of_birth)
            missing.push('date_of_birth');
        if (missing.length > 0) {
            return invalidRequest('health_verify_insurance', `Missing required fields when stedi_request is not provided: ${missing.join(', ')}`, startMs, missing.map((f) => ({ field: f, issue: 'required' })));
        }
        body = {
            controlNumber: String(Date.now()).slice(-9),
            tradingPartnerServiceId: params.payer_id ?? '00001',
            provider: { organizationName: 'Clinic', npi: params.provider_npi },
            subscriber: {
                memberId: params.member_id,
                firstName: params.first_name,
                lastName: params.last_name,
                dateOfBirth: params.date_of_birth,
            },
            encounter: {
                serviceTypeCodes: params.service_type_codes ?? ['30'],
            },
        };
    }
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            Authorization: `Key ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const text = await response.text();
        return providerError('health_verify_insurance', `Stedi eligibility check failed (${response.status}): ${text}`, startMs, response.status >= 500);
    }
    const data = (await response.json());
    return success('health_verify_insurance', {
        tool: 'health_verify_insurance',
        provider: 'stedi',
        verification_status: 'completed',
        stedi_status: response.status,
        eligibility: data,
        patient_id: params.patient_id ?? null,
        disclaimer: 'Insurance eligibility responses indicate benefit information at time of inquiry and do not guarantee coverage or payment.',
    }, startMs);
}
