# OpenEMR Health MCP — Agent Developer Guide

A practical reference for developers building AI agents that consume the OpenEMR Health MCP server. Covers tool contracts, identifier formats, response envelopes, verification levels, idempotency, error handling, and end-to-end workflow examples.

---

## Table of Contents

- [Core Concepts](#core-concepts)
  - [Response Envelope](#response-envelope)
  - [Error Codes](#error-codes)
  - [Slot ID Format](#slot-id-format)
  - [Booking Reference Format](#booking-reference-format)
  - [Verification Levels](#verification-levels)
  - [Idempotency Keys](#idempotency-keys)
- [Tool Reference](#tool-reference)
  - [Appointment Tools](#appointment-tools)
  - [Clinic Info Tools](#clinic-info-tools)
  - [Patient Tools](#patient-tools)
  - [Insurance Tool](#insurance-tool)
  - [Provider Matching Tools](#provider-matching-tools)
  - [Waitlist Tools](#waitlist-tools)
- [Agent Workflows](#agent-workflows)
  - [Book an Appointment (Recommended: Hold + Confirm)](#book-an-appointment-recommended-hold--confirm)
  - [Book an Appointment (Direct)](#book-an-appointment-direct)
  - [Reschedule an Appointment](#reschedule-an-appointment)
  - [Cancel an Appointment](#cancel-an-appointment)
  - [New Patient Intake + Booking](#new-patient-intake--booking)
  - [Waitlist Flow](#waitlist-flow)
- [PHI Masking Rules](#phi-masking-rules)
- [Persistence-Dependent Tools](#persistence-dependent-tools)
- [Design Notes for Agent Authors](#design-notes-for-agent-authors)

---

## Core Concepts

### Response Envelope

Every tool returns a JSON object with this structure:

```json
{
  "ok": true,
  "status": 200,
  "result": { ... },
  "meta": {
    "tool": "health_book_slot",
    "provider": "openemr",
    "elapsed_ms": 142
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | `true` on success, `false` on any error |
| `status` | number | HTTP-equivalent status code |
| `result` | object | Tool-specific payload (see each tool below) |
| `meta.tool` | string | Tool name that produced this response |
| `meta.provider` | string | Always `"openemr"` |
| `meta.elapsed_ms` | number | Server-side processing time |

**Always check `ok` before reading `result`.** On error, `result` contains an `error` object:

```json
{
  "ok": false,
  "status": 409,
  "result": {
    "status": "error",
    "error": {
      "code": "conflict",
      "message": "Slot emr:2026-03-20:0900:1:3:2:1800 is already booked",
      "retryable": false
    }
  },
  "meta": { "tool": "health_book_slot", "provider": "openemr", "elapsed_ms": 38 }
}
```

### Error Codes

| `error.code` | HTTP status | Meaning | Retryable? |
|---|---|---|---|
| `invalid_request` | 400 | Missing or invalid parameter | No |
| `not_found` | 404 | Resource does not exist | No |
| `conflict` | 409 | Slot already booked or duplicate | No — pick another slot |
| `precondition_failed` | 412 | Verification required, or backend not configured | No |
| `provider_error` | 502 | OpenEMR returned an unexpected error | Maybe |
| `timeout` | 504 | OpenEMR did not respond in time | Yes — back off and retry |
| `internal_error` | 500 | Unexpected server error | Maybe |
| `auth_error` | 401 | OAuth token invalid or expired (auto-refreshed) | Yes — one retry |
| `slot_unavailable` | 409 | Hold target slot was taken between check and hold | No — re-check slots |

### Slot ID Format

Slot IDs are opaque stable strings encoding all booking parameters:

```
emr:{date}:{HHmm}:{facility_id}:{provider_id}:{category_id}:{duration_secs}
```

Example: `emr:2026-03-20:0900:1:3:2:1800`

- Always treat slot IDs as opaque — do not parse or construct them manually.
- Obtain slot IDs exclusively from `health_check_slots` results.
- A slot ID becomes invalid once the appointment is booked; use the booking reference for subsequent operations.

### Booking Reference Format

```
emr:appt:{pc_eid}
```

Example: `emr:appt:142`

- Returned by `health_book_slot` and `health_confirm_booking` as `booking_ref`.
- Use `booking_ref` (not `slot_id`) for cancel and reschedule — it is more stable.
- Store it in your agent's context for the duration of the user session.

### Verification Levels

Many tools accept a `verification_level` parameter that controls PHI access and write permissions:

| Level | Meaning | When to use |
|-------|---------|-------------|
| `none` | Unverified (default) | Browsing slots, getting office hours |
| `basic` | Agent has confirmed intent | Committing a booking hold |
| `contact` | Phone/email confirmed | Viewing full patient record, cancel/reschedule |
| `strong` | Identity document or MFA | Updating patient demographics, medical history |

`verification_level` supersedes the legacy `patient_verified: true` boolean (which maps to `contact`). Pass `verification_level` explicitly in new agents.

**Policy enforcement** — tools with `requires_verification:true` in their description will return `precondition_failed` if the level is too low:

| Tool | Minimum level |
|------|--------------|
| `health_cancel_appointment` | `contact` |
| `health_reschedule_appointment` | `contact` |
| `health_confirm_booking` | `basic` |
| `health_update_patient_info` | `strong` |
| `health_collect_medical_history` | `strong` (for existing patients) |

### Idempotency Keys

Write operations (`health_book_slot`, `health_confirm_booking`, `health_cancel_appointment`, `health_reschedule_appointment`, `health_update_patient_info`, `health_new_patient_intake`, `health_collect_medical_history`) accept an optional `idempotency_key` string.

**Rules:**

1. Generate one UUID per distinct user action (not per retry).
2. On network timeout or `status 504`, retry the identical call with the **same** key.
3. The server deduplicates within 24 hours — the same key always returns the same response.
4. Never reuse a key for a different action.

```
idempotency_key: "appt-book-{user_session_id}-{timestamp_ms}"
```

---

## Tool Reference

### Appointment Tools

#### `health_check_slots`

Find available appointment slots.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | YYYY-MM-DD, `today`, `tomorrow`, `next monday` |
| `visit_type` | string | No | Appointment category name (e.g. `"Office Visit"`) |
| `provider_id` | string | No | OpenEMR provider ID |
| `timezone` | string | No | IANA timezone (e.g. `"America/Chicago"`) |
| `duration_minutes` | integer | No | Desired duration in minutes (default 30) |

**Result:**

```json
{
  "date": "2026-03-20",
  "slots": [
    {
      "slot_id": "emr:2026-03-20:0900:1:3:2:1800",
      "start": "09:00",
      "end": "09:30",
      "provider_id": "3",
      "provider_name": "Dr. Jane Smith",
      "facility_id": "1",
      "facility_name": "Main Clinic",
      "category": "Office Visit",
      "duration_minutes": 30
    }
  ],
  "total": 8
}
```

**Notes:**
- Returns only slots not already booked.
- If `date` is omitted, defaults to today.
- Use `provider_id` from a prior `health_match_provider` call for best results.

---

#### `health_hold_slot`

Reserve a slot for up to 5 minutes without committing to OpenEMR. Prevents double-booking during patient confirmation.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slot_id` | string | **Yes** | From `health_check_slots` |
| `patient_id` | string | No | OpenEMR PID |
| `patient_phone` | string | No | For patient lookup |
| `patient_email` | string | No | For patient lookup |
| `verification_level` | string | No | See [Verification Levels](#verification-levels) |
| `reason` | string | No | Appointment reason |
| `visit_type` | string | No | Override visit type |
| `duration_minutes` | integer | No | Override duration |

**Result:**

```json
{
  "hold_id": "hold_a1b2c3d4",
  "slot_id": "emr:2026-03-20:0900:1:3:2:1800",
  "expires_at": "2026-03-20T09:05:00Z",
  "ttl_seconds": 300
}
```

**Notes:**
- The slot is locked for the TTL period — no other agent can book it.
- If the hold expires before `health_confirm_booking`, call `health_check_slots` again and get a fresh slot.

---

#### `health_confirm_booking`

Commit a hold into a confirmed OpenEMR appointment. Requires `verification_level >= basic`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `hold_id` | string | **Yes** | From `health_hold_slot` |
| `idempotency_key` | string | **Yes** | Unique key for safe retry |
| `verification_level` | string | No | Minimum `basic` required |
| `reason` | string | No | Override reason |
| `provider_id` | string | No | Override provider |
| `visit_type` | string | No | Override visit type |

**Result:**

```json
{
  "status": "booked",
  "booking_ref": "emr:appt:142",
  "appointment": {
    "pc_eid": 142,
    "date": "2026-03-20",
    "start_time": "09:00",
    "end_time": "09:30",
    "provider": "Dr. Jane Smith",
    "facility": "Main Clinic",
    "visit_type": "Office Visit"
  }
}
```

---

#### `health_book_slot`

Direct booking without hold/confirm (single-step). Use `health_hold_slot` + `health_confirm_booking` for multi-turn conversations.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slot_id` | string | **Yes** | From `health_check_slots` |
| `idempotency_key` | string | No | Recommended for safe retry |
| `patient_id` | string | No | OpenEMR PID |
| `patient_name` | string | No | Full name |
| `patient_phone` | string | No | |
| `patient_email` | string | No | |
| `verification_level` | string | No | |
| `reason` | string | No | Appointment reason |
| `visit_type` | string | No | Override visit type |
| `provider_id` | string | No | Override provider |

**Result:** Same as `health_confirm_booking`.

---

#### `health_list_appointments`

List appointments for a patient. PHI is masked unless `verification_level >= contact`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `patient_id` | string | No | OpenEMR PID |
| `patient_phone` | string | No | |
| `patient_email` | string | No | |
| `verification_level` | string | No | |
| `from_date` | string | No | YYYY-MM-DD or natural phrase |
| `to_date` | string | No | YYYY-MM-DD or natural phrase |
| `status` | string | No | OpenEMR status code filter |
| `limit` | integer | No | Max results (default 10) |

**Result (unverified):**

```json
{
  "appointments": [
    {
      "booking_ref": "emr:appt:142",
      "date": "2026-03-20",
      "time": "09:00",
      "provider": "***",
      "masked": true
    }
  ],
  "total": 1,
  "patient_verified": false
}
```

**Result (verified):** Full appointment details including provider name, facility, and visit type.

---

#### `health_cancel_appointment`

Cancel an existing appointment. Requires `verification_level >= contact`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `booking_ref` | string | No* | From `health_book_slot` / `health_confirm_booking` |
| `slot_id` | string | No* | Fallback if booking_ref unavailable |
| `idempotency_key` | string | No | |
| `verification_level` | string | No | Minimum `contact` |
| `cancel_reason` | string | No | |

*One of `booking_ref` or `slot_id` is required.

**Result:**

```json
{
  "status": "cancelled",
  "booking_ref": "emr:appt:142"
}
```

---

#### `health_reschedule_appointment`

Move an existing appointment to a new slot. Requires `verification_level >= contact`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `new_slot_id` | string | **Yes** | Target slot from `health_check_slots` |
| `booking_ref` | string | No* | Existing appointment reference |
| `slot_id` | string | No* | Fallback identifier |
| `idempotency_key` | string | No | |
| `verification_level` | string | No | Minimum `contact` |
| `reason` | string | No | Override reason |

*One of `booking_ref` or `slot_id` is required.

**Result:**

```json
{
  "status": "rescheduled",
  "old_booking_ref": "emr:appt:142",
  "new_booking_ref": "emr:appt:143",
  "appointment": { ... }
}
```

**Notes:** Internally cancels the old appointment and creates a new one. The old `booking_ref` becomes invalid; use `new_booking_ref` going forward.

---

### Clinic Info Tools

#### `health_get_office_hours`

**Parameters:** `location_id` (optional), `day` (optional, e.g. `"monday"`)

**Result:**

```json
{
  "office_hours": [
    { "day": "monday",  "open": "09:00", "close": "17:00", "closed": false },
    { "day": "saturday", "open": null,   "close": null,    "closed": true  }
  ]
}
```

---

#### `health_get_location`

**Parameters:** `location_id` (optional), `query` (optional search string), `limit` (optional, default 20)

**Result:**

```json
{
  "locations": [
    {
      "id": "1",
      "name": "Main Clinic",
      "address": "123 Main St",
      "city": "Springfield",
      "state": "IL",
      "zip": "62701",
      "phone": "555-0100"
    }
  ],
  "total": 1
}
```

---

#### `health_get_billing_policy`

**Parameters:** `topic` (optional: `insurance` | `copay` | `cancellation` | `refund` | `payment_plan`)

**Result:**

```json
{
  "billing_policy": {
    "insurance": "We accept most major insurance plans.",
    "copay": "$20 copay due at time of service.",
    "cancellation": "Cancel 24+ hours in advance to avoid fees."
  }
}
```

---

#### `health_get_procedure_catalog`

**Parameters:** `procedure_code` (optional), `query` (optional fuzzy search), `limit` (optional)

**Result:**

```json
{
  "procedures": [
    {
      "id": "2",
      "code": "OV",
      "name": "Office Visit",
      "duration_minutes": 30,
      "description": "General office visit"
    }
  ],
  "total": 5
}
```

Use `name` values from this catalog as `visit_type` in appointment tools.

---

### Patient Tools

#### `health_lookup_patient`

Look up by ID, phone, or email. Returns masked data unless verified.

**Parameters:** `patient_id`, `patient_phone`, `patient_email` (at least one), `verification_level`

**Result (unverified):**

```json
{
  "status": "found",
  "patient_found": true,
  "patient_verified": false,
  "patient_id": "42",
  "patient": { "fname": "J***", "lname": "D***", "phone": null, "email": null, "DOB": null },
  "message": "Patient found but details are masked. Verify patient identity to access full record."
}
```

**Result (verified, `verification_level: "contact"`):**

```json
{
  "status": "found",
  "patient_found": true,
  "patient_verified": true,
  "patient_id": "42",
  "fname": "Jane",
  "lname": "Doe",
  "phone": "555-0199",
  "email": "jane@example.com",
  "DOB": "1985-04-12",
  "sex": "Female"
}
```

---

#### `health_update_patient_info`

Update patient demographics. Requires `verification_level >= strong`.

**Parameters:**

| Parameter | Type | Required |
|-----------|------|----------|
| `patient_id` / `patient_phone` / `patient_email` | string | One required |
| `verification_level` | string | Must be `strong` |
| `updates` | object | Fields to update (e.g. `{ "email": "new@example.com" }`) |
| `idempotency_key` | string | Recommended |

---

#### `health_new_patient_intake`

Create a new patient record in OpenEMR.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `intake` | object | **Yes** | Patient fields (see OpenEMR patient schema) |
| `source` | string | No | `voice` \| `web` \| `chat` \| `agent` \| `unknown` |
| `idempotency_key` | string | No | |

**Minimum `intake` fields:**

```json
{
  "fname": "Jane",
  "lname": "Doe",
  "DOB": "1985-04-12",
  "sex": "Female",
  "phone_cell": "555-0199"
}
```

**Result:**

```json
{
  "status": "submitted",
  "result": { "patient_id": "42", "fname": "Jane", "lname": "Doe" },
  "persistence": "persisted"
}
```

Use `result.patient_id` in subsequent booking calls.

---

#### `health_collect_medical_history`

Record medical history for a patient. Requires `verification_level >= strong` for existing patients.

**Parameters:**

| Parameter | Type | Required |
|-----------|------|----------|
| `history` | object | **Yes** — medical history fields |
| `patient_id` | string | Required if `new_patient_reference` absent |
| `new_patient_reference` | string | Reference key if patient record not yet created |
| `verification_level` | string | Required `strong` for existing patients |
| `idempotency_key` | string | Recommended |

---

### Insurance Tool

#### `health_verify_insurance`

Verify eligibility via Stedi. Requires `STEDI_API_KEY` environment variable to be configured.

**Parameters (shorthand — no `stedi_request`):**

| Parameter | Type | Required |
|-----------|------|----------|
| `provider_npi` | string | Yes |
| `member_id` | string | Yes |
| `first_name` | string | Yes |
| `last_name` | string | Yes |
| `date_of_birth` | string | Yes (YYYY-MM-DD) |
| `payer_id` | string | No |
| `service_type_codes` | string[] | No (default `["30"]`) |
| `patient_id` | string | No |

Pass `stedi_request` instead to forward a raw Stedi payload directly.

---

### Provider Matching Tools

#### `health_match_provider`

Match providers by visit type and availability range.

**Parameters:**

| Parameter | Type | Required |
|-----------|------|----------|
| `visit_type` | string | **Yes** |
| `request_start_date` | string | **Yes** (YYYY-MM-DD) |
| `request_end_date` | string | **Yes** |
| `duration_minutes` | integer | **Yes** |
| `max_results` | integer | **Yes** (1–20) |
| `preferred_provider_ids` | string[] | No |
| `provider_gender` | string | No |
| `language` | string | No |
| `time_of_day` | string | No (`morning`\|`afternoon`\|`evening`\|`any`) |
| `location_id` | string | No |
| `timezone` | string | No |
| `patient_id` | string | No (enables preference merge) |
| `include_saved_preferences` | boolean | No |

**Result:**

```json
{
  "matches": [
    {
      "provider_id": "3",
      "provider_name": "Dr. Jane Smith",
      "match_score": 0.95,
      "next_available": "2026-03-21",
      "slot_candidates": [
        {
          "slot_id": "emr:2026-03-21:0900:1:3:2:1800",
          "start_at": "2026-03-21T09:00:00",
          "end_at": "2026-03-21T09:30:00"
        }
      ]
    }
  ],
  "total": 2
}
```

Pass `provider_id` from a match into `health_check_slots` to get a bookable slot.

---

#### `health_patient_preferences_upsert` / `health_patient_preferences_get`

Save and retrieve scheduling preferences per patient. Requires `PREFERENCES_BACKEND_URL`.

**Upsert parameters:** `patient_id` (required), `preferences` object (required), `mode` (`merge`|`replace`)

**Preferences fields:** `preferred_provider_ids`, `provider_gender`, `language`, `time_of_day`, `location_id`

---

### Waitlist Tools

All waitlist tools require `WAITLIST_BACKEND_URL` to be configured. When not set, they return `precondition_failed`.

#### `health_waitlist_add`

| Parameter | Type | Required |
|-----------|------|----------|
| `patient_id` | string | **Yes** |
| `visit_type` | string | **Yes** |
| `request_start_date` | string | **Yes** (YYYY-MM-DD) |
| `request_end_date` | string | **Yes** |
| `priority` | integer | **Yes** (1=highest, 5=lowest) |
| `channels` | object | **Yes** `{ sms, voice, email }` |
| `time_of_day` | string | No |
| `preferred_provider_ids` | string[] | No |
| `consent_verified` | boolean | No |
| `idempotency_key` | string | Recommended |

**Result:** `{ status: "ok", waitlist_entry: { id, ... } }`

---

#### `health_waitlist_list`

Filter: `patient_id`, `statuses` (`active`|`offered`|`booked`|`removed`|`expired`), `from_date`, `to_date`, `limit`, `cursor`

---

#### `health_waitlist_remove`

| Parameter | Type | Required |
|-----------|------|----------|
| `waitlist_entry_id` | string | **Yes** |
| `reason` | string | No |
| `removed_by` | string | No (`patient`\|`agent`\|`system`) |
| `idempotency_key` | string | No |

---

#### `health_waitlist_offer`

Send a slot offer to a waitlisted patient. Exactly one expiry mode required.

| Parameter | Type | Required |
|-----------|------|----------|
| `waitlist_entry_id` | string | **Yes** |
| `slot_id` | string | **Yes** |
| `provider_id` | string | **Yes** |
| `start_at` | string | **Yes** (RFC3339) |
| `end_at` | string | **Yes** (RFC3339) |
| `offered_via` | string | **Yes** (`sms`\|`voice`\|`email`\|`manual`) |
| `idempotency_key` | string | **Yes** |
| `expires_at` | string | One required (RFC3339) |
| `expires_in_seconds` | integer | One required (60–86400) |

---

#### `health_waitlist_confirm_offer`

| Parameter | Type | Required |
|-----------|------|----------|
| `offer_id` | string | **Yes** |
| `decision` | string | **Yes** (`accept`\|`decline`) |
| `confirmed_via` | string | **Yes** (`sms`\|`voice`\|`email`\|`agent`\|`system`) |
| `idempotency_key` | string | **Yes** |
| `patient_id` | string | No |

**Result:**

```json
{
  "status": "accepted",
  "booking_ref": "emr:appt:201",
  "offer": { ... },
  "message": "Offer accepted via sms"
}
```

---

## Agent Workflows

### Book an Appointment (Recommended: Hold + Confirm)

Use this pattern in multi-turn conversations where the patient reviews the slot before confirming.

```
1. health_get_procedure_catalog         → pick visit_type
2. health_match_provider                → pick provider_id
3. health_check_slots (date, provider)  → pick slot_id
4. health_hold_slot (slot_id)           → get hold_id + expires_at
5.   [present slot to user, await confirmation]
6. health_confirm_booking (hold_id, idempotency_key, verification_level: "basic")
                                        → booking_ref
```

If the hold expires between steps 4 and 6, re-run from step 3.

---

### Book an Appointment (Direct)

Use in fully automated flows with no patient confirmation step.

```
1. health_check_slots                   → slot_id
2. health_book_slot (slot_id, idempotency_key)
                                        → booking_ref
```

---

### Reschedule an Appointment

```
1. health_list_appointments (patient_id, verification_level: "contact")
                                        → existing booking_ref
2. health_check_slots (new date/provider) → new_slot_id
3. health_reschedule_appointment (booking_ref, new_slot_id, idempotency_key,
                                  verification_level: "contact")
                                        → new_booking_ref
```

---

### Cancel an Appointment

```
1. [agent already has booking_ref from prior turn]
   — OR —
   health_list_appointments (verification_level: "contact") → booking_ref
2. health_cancel_appointment (booking_ref, idempotency_key,
                               verification_level: "contact")
                                        → { status: "cancelled" }
```

---

### New Patient Intake + Booking

```
1. health_new_patient_intake (intake: { fname, lname, DOB, ... },
                               idempotency_key)
                                        → patient_id
2. health_collect_medical_history (patient_id, history: { ... },
                                   verification_level: "strong",
                                   idempotency_key)
3. health_check_slots                   → slot_id
4. health_hold_slot (slot_id, patient_id)  → hold_id
5. health_confirm_booking (hold_id, idempotency_key,
                            verification_level: "basic")
                                        → booking_ref
```

---

### Waitlist Flow

```
1. health_check_slots                   → no available slots
2. health_waitlist_add (patient_id, visit_type, date_range, priority, channels,
                        consent_verified: true, idempotency_key)
                                        → waitlist_entry_id

[Later — when a slot opens:]
3. health_check_slots                   → slot_id
4. health_waitlist_offer (waitlist_entry_id, slot_id, ...,
                          expires_in_seconds: 3600, idempotency_key)
                                        → offer_id
5. health_waitlist_confirm_offer (offer_id, decision: "accept",
                                  confirmed_via: "sms", idempotency_key)
                                        → booking_ref
```

---

## PHI Masking Rules

Patient health information (PHI) is gated behind `verification_level`:

| Data field | Unverified response | Verified response |
|---|---|---|
| First/last name | `J***` / `D***` | Full name |
| Phone | `null` | Full number |
| Email | `null` | Full address |
| Date of birth | `null` | Full DOB |
| Appointment provider | `***` | Provider name |
| Appointment details | Booking ref only | Full details |

Pass `verification_level: "contact"` (or higher) only after your agent has confirmed patient identity through an out-of-band step (e.g. sending a verification code to the patient's phone).

---

## Persistence-Dependent Tools

The following tools return `precondition_failed` (HTTP 412) when the corresponding backend is not configured. This is expected behavior — no data is lost.

| Tools | Required env var | Fallback behavior |
|-------|-----------------|-------------------|
| `health_waitlist_*` (5 tools) | `WAITLIST_BACKEND_URL` | Returns 412 with clear message |
| `health_patient_preferences_*` (2 tools) | `PREFERENCES_BACKEND_URL` | Returns 412 with clear message |
| `health_verify_insurance` | `STEDI_API_KEY` | Returns 412 with clear message |

Your agent should gracefully handle 412 responses by informing the user that the feature is not available in this deployment.

---

## Design Notes for Agent Authors

**Prefer hold+confirm over direct booking** in any multi-turn flow. It prevents double-booking when the patient takes time to decide, and the idempotency key on confirm makes network retries safe.

**Always store `booking_ref`**, not `slot_id`, after a successful booking. The slot is gone once booked; the booking reference is the stable identifier for all subsequent operations.

**Check `ok` first.** Do not access `result` fields when `ok` is false. The `error.code` field tells you whether to retry, escalate to a human agent, or inform the patient.

**Generate idempotency keys at the action boundary**, not at the API call boundary. One user click = one key. All retries of that action use the same key.

**Never construct slot IDs.** Only consume them from `health_check_slots` results. Constructed slot IDs will pass schema validation but will fail at booking time with `not_found`.

**Use `health_match_provider` before `health_check_slots`** when the patient has preferences (gender, language, time of day). The match score factors these in and returns the best provider first, reducing the number of slot queries needed.

**Natural language dates** (`today`, `tomorrow`, `next monday`, `next week`) are resolved server-side relative to UTC. Pass explicit `YYYY-MM-DD` dates when your agent has access to the patient's timezone.
