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
export {};
