/**
 * Verification-level policy enforcement for write tools.
 *
 * Verification levels (weakest → strongest):
 *   none     - no patient identity confirmed
 *   basic    - name + DOB match
 *   contact  - OTP sent to phone/email and confirmed
 *   strong   - portal-authenticated or staff-confirmed
 *
 * Backwards compatibility: the boolean patient_verified=true maps to "contact".
 *
 * Per-tool minimum levels:
 *   Read tools              none    (masking applied in handler, not blocked here)
 *   hold/book               none    (patient identity required but not verified)
 *   confirm_booking         basic
 *   cancel/reschedule       contact
 *   update demographics     strong
 *   collect medical history strong
 *   waitlist add            basic
 */
import { preconditionFailed, type CanonicalResponse } from '../response.js';

export type VerificationLevel = 'none' | 'basic' | 'contact' | 'strong';

const LEVEL_ORDER: Record<VerificationLevel, number> = {
  none: 0,
  basic: 1,
  contact: 2,
  strong: 3,
};

/** Minimum verification level required to execute each write tool. */
const REQUIRED_LEVEL: Partial<Record<string, VerificationLevel>> = {
  health_hold_slot: 'none',
  health_book_slot: 'none',
  health_confirm_booking: 'basic',
  health_cancel_appointment: 'contact',
  health_reschedule_appointment: 'contact',
  health_update_patient_info: 'strong',
  health_collect_medical_history: 'strong',
  health_new_patient_intake: 'none',
  health_waitlist_add: 'basic',
  health_waitlist_offer: 'basic',
  health_waitlist_confirm_offer: 'basic',
};

/**
 * Resolves the effective verification level from tool params.
 * Accepts both the new `verification_level` enum field and the legacy `patient_verified` boolean.
 */
export function resolveLevel(params: {
  patient_verified?: boolean;
  verification_level?: string;
}): VerificationLevel {
  if (params.verification_level && params.verification_level in LEVEL_ORDER) {
    return params.verification_level as VerificationLevel;
  }
  // Legacy boolean: true → contact, false → none
  return params.patient_verified ? 'contact' : 'none';
}

/**
 * Returns a precondition_failed response if the tool's required level is not met,
 * otherwise returns null (allow).
 */
export function enforcePolicy(
  tool: string,
  level: VerificationLevel,
  startMs: number,
): CanonicalResponse | null {
  const required = REQUIRED_LEVEL[tool];
  if (!required || LEVEL_ORDER[level] >= LEVEL_ORDER[required]) return null;
  return preconditionFailed(
    tool,
    `"${tool}" requires verification level "${required}" but received "${level}". ` +
      `Verify patient identity before calling this tool.`,
    startMs,
  );
}
