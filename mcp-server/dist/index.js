#!/usr/bin/env node
/**
 * OpenEMR Health MCP Server
 *
 * Implements the canonical Health MCP Tools Specification.
 * All 24 tools use the canonical naming convention (health_*) and conform
 * to the parameter and response contracts defined in the spec.
 *
 * Required environment variables:
 *   OPENEMR_BASE_URL       https://localhost:9300
 *   OPENEMR_CLIENT_ID      OAuth2 client ID
 *   OPENEMR_CLIENT_SECRET  OAuth2 client secret
 *   OPENEMR_USERNAME       OpenEMR user with Appointments ACL
 *   OPENEMR_PASSWORD       Password for that user
 *
 * Optional environment variables:
 *   OPENEMR_SITE              Site slug (default: "default")
 *   OFFICE_HOURS_JSON         JSON array of office hours (fallback to 08:00–17:00)
 *   BILLING_POLICY_JSON       JSON object of billing policies
 *   STEDI_API_KEY             Stedi API key for health_verify_insurance
 *   STEDI_ENDPOINT            Stedi eligibility endpoint URL
 *   PREFERENCES_BACKEND_URL   HTTP backend for patient preferences
 *   WAITLIST_BACKEND_URL      HTTP backend for waitlist operations
 */
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { checkSlotsSchema, holdSlotSchema, confirmBookingSchema, bookSlotSchema, listAppointmentsSchema, cancelAppointmentSchema, rescheduleAppointmentSchema, checkSlots, holdSlot, confirmBooking, bookSlot, listAppointments, cancelAppointment, rescheduleAppointment, } from './tools/appointments.js';
import { lookupPatientSchema, updatePatientInfoSchema, newPatientIntakeSchema, collectMedicalHistorySchema, lookupPatient, updatePatientInfo, newPatientIntake, collectMedicalHistory, } from './tools/patients.js';
import { getOfficeHoursSchema, getLocationSchema, getBillingPolicySchema, getProcedureCatalogSchema, getOfficeHours, getLocation, getBillingPolicy, getProcedureCatalog, } from './tools/clinic-info.js';
import { verifyInsuranceSchema, verifyInsurance, } from './tools/insurance.js';
import { matchProviderSchema, preferencesUpsertSchema, preferencesGetSchema, matchProvider, patientPreferencesUpsert, patientPreferencesGet, } from './tools/provider-matching.js';
import { waitlistAddSchema, waitlistListSchema, waitlistRemoveSchema, waitlistOfferSchema, waitlistConfirmOfferSchema, waitlistAdd, waitlistList, waitlistRemove, waitlistOffer, waitlistConfirmOffer, } from './tools/waitlist.js';
import { withCanonical } from './response.js';
/**
 * Spec annotations map to MCP SDK standard hints:
 *   provider_kind      → title prefix
 *   risk_level=low     → readOnlyHint=true (no side effects)
 *   risk_level=high    → destructiveHint=true
 *   idempotent=true    → idempotentHint=true
 *   requires_verify    → embedded in description text
 */
const server = new McpServer({
    name: 'openemr-health',
    version: '1.0.0',
});
// ── §4.1 Appointment operations ───────────────────────────────────────────────
server.tool('health_hold_slot', '[provider_kind:appointments risk_level:low requires_verification:false] Reserve a slot for a short TTL (default 5 min) without committing to OpenEMR. Returns a hold_id. Use health_confirm_booking to commit.', holdSlotSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_hold_slot', (t) => holdSlot(params, t), { patient_id: params.patient_id }));
server.tool('health_confirm_booking', '[provider_kind:appointments risk_level:medium requires_verification:true] Commit a hold (from health_hold_slot) into a confirmed OpenEMR appointment. Requires idempotency_key and verification_level >= basic.', confirmBookingSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, (params) => withCanonical('health_confirm_booking', (t) => confirmBooking(params, t), { idempotency_key: params.idempotency_key }));
server.tool('health_check_slots', '[provider_kind:appointments risk_level:low requires_verification:false] Check available appointment slots in OpenEMR. Supports natural language dates (today, tomorrow, next monday).', checkSlotsSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_check_slots', (t) => checkSlots(params, t)));
server.tool('health_book_slot', '[provider_kind:appointments risk_level:medium requires_verification:false] Book an available appointment slot for a patient. Requires a slot_id from health_check_slots and patient identification.', bookSlotSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_book_slot', (t) => bookSlot(params, t)));
server.tool('health_list_appointments', '[provider_kind:appointments risk_level:low requires_verification:false] List appointments for a patient. Returns masked results unless patient_verified is true.', listAppointmentsSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_list_appointments', (t) => listAppointments(params, t)));
server.tool('health_cancel_appointment', '[provider_kind:appointments risk_level:medium requires_verification:false] Cancel an existing appointment. Requires booking_ref or slot_id.', cancelAppointmentSchema.shape, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }, (params) => withCanonical('health_cancel_appointment', (t) => cancelAppointment(params, t)));
server.tool('health_reschedule_appointment', '[provider_kind:appointments risk_level:medium requires_verification:false] Reschedule an appointment to a new slot. Requires new_slot_id and one of booking_ref or slot_id.', rescheduleAppointmentSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_reschedule_appointment', (t) => rescheduleAppointment(params, t)));
// ── §4.2 Clinic info services ─────────────────────────────────────────────────
server.tool('health_get_office_hours', '[provider_kind:appointments risk_level:low requires_verification:false] Get clinic office hours. Returns configured hours or defaults (Mon–Fri 08:00–17:00). Optionally filter by location or day.', getOfficeHoursSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_get_office_hours', (t) => getOfficeHours(params, t)));
server.tool('health_get_location', '[provider_kind:appointments risk_level:low requires_verification:false] Get clinic location(s) from OpenEMR facility data. Supports filtering by location_id or search query.', getLocationSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_get_location', (t) => getLocation(params, t)));
server.tool('health_get_billing_policy', '[provider_kind:appointments risk_level:low requires_verification:false] Get clinic billing policy information. Returns from BILLING_POLICY_JSON config or a default message. Optionally filter by topic.', getBillingPolicySchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_get_billing_policy', (t) => getBillingPolicy(params, t)));
server.tool('health_get_procedure_catalog', '[provider_kind:appointments risk_level:low requires_verification:false] Get available procedure/visit types from OpenEMR appointment categories. Supports code and fuzzy name search.', getProcedureCatalogSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_get_procedure_catalog', (t) => getProcedureCatalog(params, t)));
// ── §4.3 Patient management ───────────────────────────────────────────────────
server.tool('health_lookup_patient', '[provider_kind:appointments risk_level:low requires_verification:false] Look up a patient by ID, phone, or email. Returns masked data unless patient_verified is true.', lookupPatientSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_lookup_patient', (t) => lookupPatient(params, t)));
server.tool('health_update_patient_info', '[provider_kind:appointments risk_level:high requires_verification:true] Update demographic or contact information for an existing patient. patient_verified must be true.', updatePatientInfoSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_update_patient_info', (t) => updatePatientInfo(params, t)));
server.tool('health_new_patient_intake', '[provider_kind:appointments risk_level:medium requires_verification:false] Create a new patient record in OpenEMR via intake data.', newPatientIntakeSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_new_patient_intake', (t) => newPatientIntake(params, t)));
server.tool('health_collect_medical_history', '[provider_kind:appointments risk_level:high requires_verification:true] Record medical history for a patient. For existing patients, patient_verified must be true.', collectMedicalHistorySchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_collect_medical_history', (t) => collectMedicalHistory(params, t)));
server.tool('health_verify_insurance', '[provider_kind:appointments risk_level:low requires_verification:false] Verify patient insurance eligibility via Stedi. Requires STEDI_API_KEY environment variable.', verifyInsuranceSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_verify_insurance', (t) => verifyInsurance(params, t)));
// ── §4.4 Provider matching + waitlist ─────────────────────────────────────────
server.tool('health_match_provider', '[provider_kind:appointments risk_level:low requires_verification:false] Match available providers based on visit type, date range, and preferences using OpenEMR provider data.', matchProviderSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_match_provider', (t) => matchProvider(params, t)));
server.tool('health_patient_preferences_upsert', '[provider_kind:appointments risk_level:low requires_verification:false] Save or update scheduling preferences for a patient. Requires PREFERENCES_BACKEND_URL to be configured.', preferencesUpsertSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_patient_preferences_upsert', (t) => patientPreferencesUpsert(params, t)));
server.tool('health_patient_preferences_get', '[provider_kind:appointments risk_level:low requires_verification:false] Retrieve saved scheduling preferences for a patient. Requires PREFERENCES_BACKEND_URL to be configured.', preferencesGetSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_patient_preferences_get', (t) => patientPreferencesGet(params, t)));
server.tool('health_waitlist_add', '[provider_kind:appointments risk_level:low requires_verification:false] Add a patient to the appointment waitlist. Requires WAITLIST_BACKEND_URL to be configured.', waitlistAddSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_waitlist_add', (t) => waitlistAdd(params, t)));
server.tool('health_waitlist_list', '[provider_kind:appointments risk_level:low requires_verification:false] List waitlist entries with optional filters. Requires WAITLIST_BACKEND_URL to be configured.', waitlistListSchema.shape, { readOnlyHint: true, idempotentHint: true }, (params) => withCanonical('health_waitlist_list', (t) => waitlistList(params, t)));
server.tool('health_waitlist_remove', '[provider_kind:appointments risk_level:low requires_verification:false] Remove a patient from the waitlist. Requires WAITLIST_BACKEND_URL to be configured.', waitlistRemoveSchema.shape, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }, (params) => withCanonical('health_waitlist_remove', (t) => waitlistRemove(params, t)));
server.tool('health_waitlist_offer', '[provider_kind:appointments risk_level:medium requires_verification:false] Send a waitlist slot offer to a patient. Requires WAITLIST_BACKEND_URL. Exactly one expiry mode required (expires_at or expires_in_seconds).', waitlistOfferSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, (params) => withCanonical('health_waitlist_offer', (t) => waitlistOffer(params, t)));
server.tool('health_waitlist_confirm_offer', '[provider_kind:appointments risk_level:medium requires_verification:false] Confirm or decline a waitlist slot offer. Idempotent per idempotency_key. Requires WAITLIST_BACKEND_URL.', waitlistConfirmOfferSchema.shape, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, (params) => withCanonical('health_waitlist_confirm_offer', (t) => waitlistConfirmOffer(params, t)));
// ── Start ─────────────────────────────────────────────────────────────────────
// ── Transport selection ───────────────────────────────────────────────────────
// Set MCP_PORT to run as a persistent HTTP service (for Docker / production).
// Leave unset to run in stdio mode (for Claude Code CLI / local subprocess).
async function startHttp(port) {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session pinning needed
    });
    await server.connect(transport);
    const httpServer = http.createServer(async (req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', tools: 24, server: 'openemr-health-mcp' }));
            return;
        }
        if (req.url === '/mcp' || req.url === '/') {
            // Collect body for POST requests
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', async () => {
                let parsedBody = undefined;
                if (chunks.length > 0) {
                    try {
                        parsedBody = JSON.parse(Buffer.concat(chunks).toString());
                    }
                    catch {
                        // non-JSON body (GET/DELETE) — pass undefined
                    }
                }
                await transport.handleRequest(req, res, parsedBody);
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found. Use POST /mcp for MCP protocol or GET /health for health check.');
    });
    httpServer.listen(port, () => {
        console.error(`OpenEMR Health MCP server listening on http://0.0.0.0:${port}/mcp (24 tools)`);
    });
}
async function startStdio() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('OpenEMR Health MCP server running on stdio — 24 canonical health_* tools available');
}
async function main() {
    const port = process.env['MCP_PORT'] ? parseInt(process.env['MCP_PORT'], 10) : undefined;
    if (port) {
        await startHttp(port);
    }
    else {
        await startStdio();
    }
}
main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
