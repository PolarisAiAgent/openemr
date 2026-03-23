# MCP Testing: Example Clinic Setup in OpenEMR

This tutorial walks a tester through creating a minimal but complete clinic in OpenEMR so that every MCP tool can be exercised. It covers admin UI steps and then shows the MCP tool call to verify each piece of data.

**Prerequisites:**
- OpenEMR running at `https://localhost` (Docker production stack)
- MCP server running at `http://localhost:3100`
- Login: `admin` / `pass`
- OAuth2 client registered and credentials in `.env` (see `README.md`)

---

## Table of Contents

0. [Register and Enable the OAuth2 Client](#0-register-and-enable-the-oauth2-client)
1. [Enable the REST API](#1-enable-the-rest-api)
2. [Create a Facility (Clinic Location)](#2-create-a-facility-clinic-location)
3. [Create Appointment Categories (Visit Types)](#3-create-appointment-categories-visit-types)
4. [Create Provider Accounts](#4-create-provider-accounts)
5. [Configure Office Hours](#5-configure-office-hours)
6. [Configure Billing Policy](#6-configure-billing-policy)
7. [Create Test Patients](#7-create-test-patients)
8. [Create a Test Appointment](#8-create-a-test-appointment)
9. [Verify Everything with MCP Tools](#9-verify-everything-with-mcp-tools)
10. [Quick Test Sequence](#10-quick-test-sequence)
11. [Provider Schedules for One Year](#11-provider-schedules-for-one-year)
    - [11.1 Enter Provider Availability Blocks](#111-enter-provider-availability-blocks-in-the-openemr-calendar)
    - [11.2 Verify the New REST Endpoint](#112-verify-the-new-rest-endpoint-directly)
    - [11.3 Seed Realistic Appointments](#113-seed-realistic-appointments-bulk-script)
    - [11.4 Verify Year-Round Slot Availability](#114-verify-year-round-slot-availability)
    - [11.5 Scenario Reference](#115-scenario-reference-for-agent-testing)
    - [11.6 Reset / Wipe Seeded Appointments](#116-reset--wipe-seeded-appointments)

---

## 0. Register and Enable the OAuth2 Client

Do this once per OpenEMR instance before any other steps.

### 0.1 Register the client

```bash
curl -s -X POST http://localhost/oauth2/default/registration \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "openemr-mcp",
    "application_type": "private",
    "redirect_uris": ["https://localhost/callback"],
    "grant_types": ["password", "authorization_code"],
    "scope": "openid api:oemr user/Patient.read user/Appointment.read user/Appointment.write"
  }'
```

Copy `client_id` and `client_secret` from the response into `docker/production/.env`:

```env
OPENEMR_CLIENT_ID=<client_id from response>
OPENEMR_CLIENT_SECRET=<client_secret from response>
```

Then restart the MCP container:

```bash
docker compose restart openemr-mcp
```

### 0.2 Enable the client in the admin UI

Clients with `user/*` scopes are created **disabled** and require manual approval.

1. Log in as `admin`.
2. Navigate to `https://localhost/interface/smart/register-app.php`
3. Find `openemr-mcp` in the list — it will show as disabled.
4. Click **Enable**.

### 0.3 Enable the Password Grant

OpenEMR disables the Password Grant by default.

1. Navigate to **Administration → Config → Connectors**.
2. Search for `password`.
3. Enable **"Enable OAuth2 Password Grant (Not SMART on FHIR Compliant)"**.
4. Click **Save**.

### 0.4 Verify — obtain a token

```bash
TOKEN=$(curl -s -X POST http://localhost/oauth2/default/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' \
  -d 'client_id=YOUR_CLIENT_ID' \
  -d 'client_secret=YOUR_CLIENT_SECRET' \
  -d 'username=admin' \
  -d 'password=pass' \
  -d 'user_role=users' \
  -d 'scope=openid api:oemr user/Patient.read user/Appointment.read user/Appointment.write' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo $TOKEN
```

`user_role=users` is required for admin/provider accounts (`user_role=patient` for patient portal accounts).

---

## 1. Enable the REST API

> Skip if already done. The MCP server will return auth errors for all tool calls if the API is disabled.

1. Log in as `admin`.
2. Navigate to **Administration → Config**.
3. In the left sidebar click **Connectors**.
4. Use the search box at the top of the settings list and search for each term below:

| Search term | Setting name | Value to set |
|-------------|-------------|--------------|
| `site` | **Site Address (required for OAuth2)** | `https://localhost` |
| `rest` | **Enable OpenEMR Standard REST API** | ☑ checked |
| `fhir` | **Enable OpenEMR Standard FHIR REST API** | ☑ checked |

5. Click **Save**.

**Verify:**

First, obtain a token (replace `YOUR_CLIENT_ID` and `YOUR_CLIENT_SECRET` with the values from `docker/production/.env`):

```bash
TOKEN=$(curl -s -X POST http://localhost/oauth2/default/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' \
  -d 'client_id=YOUR_CLIENT_ID' \
  -d 'client_secret=YOUR_CLIENT_SECRET' \
  -d 'username=admin' \
  -d 'password=pass' \
  -d 'user_role=users' \
  -d 'scope=openid api:oemr user/Patient.read user/Appointment.read user/Appointment.write' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

Then call the API:

```bash
curl -sk https://localhost/apis/default/api/facility -H "Authorization: Bearer $TOKEN"
```

Should return JSON (not an auth error).

---

## 2. Create a Facility (Clinic Location)

The facility record is what `health_get_location` and `health_check_slots` return as the clinic location.

1. Navigate to **Administration → Clinic → Facilities**.
2. Click **Add Facility**.
3. Fill in:

| Field | Example value |
|-------|--------------|
| **Name** | `Sunridge Family Clinic` |
| **Phone** | `555-0100` |
| **Fax** | `555-0101` |
| **Street** | `400 Sunridge Blvd` |
| **City** | `Springfield` |
| **State** | `IL` |
| **Zip** | `62701` |
| **Country** | `US` |
| **Tax ID** | `12-3456789` |
| **NPI** | `1234567890` |
| **Color** | any |

4. Click **Save**.
5. Note the **Facility ID** shown after saving (usually `1` if this is the first).

**MCP verify:**
```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_get_location",
    "arguments": { "query": "Sunridge" }
  }}'
```
Expected: `locations` array contains `Sunridge Family Clinic` with address fields.

---

## 3. Create Appointment Categories (Visit Types)

Appointment categories define visit types and slot durations. `health_get_procedure_catalog` and `health_check_slots` rely on these.

1. Navigate to **Admin → Clinic → Calendar**.
2. Scroll to the **bottom** of the page to the blank **Add** form (do **not** edit the existing system categories like "No Show").
3. Fill in the fields and click **Save** for each new category:

### Category — Office Visit

| Field | Value |
|-------|-------|
| **Name** | `Office Visit` |
| **Identifier** | `office_visit` |
| **Duration Hours** | `0`, **Minutes** `30` |
| **Color** | click **[pick]** and choose a green |
| **Description** | `General outpatient office visit` |
| **Active** | Yes |

### Category — New Patient Consultation

| Field | Value |
|-------|-------|
| **Name** | `New Patient Consultation` |
| **Identifier** | `new_patient` |
| **Duration Hours** | `1`, **Minutes** `0` |
| **Color** | click **[pick]** and choose a blue |
| **Description** | `Initial consultation for new patients` |
| **Active** | Yes |

### Category — Follow-Up

| Field | Value |
|-------|-------|
| **Name** | `Follow-Up` |
| **Identifier** | `follow_up` |
| **Duration Hours** | `0`, **Minutes** `15` |
| **Color** | click **[pick]** and choose an orange |
| **Description** | `Follow-up appointment` |
| **Active** | Yes |

4. Click **Save** after filling in each category.

**MCP verify:**
```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_get_procedure_catalog",
    "arguments": {}
  }}'
```
Expected: `procedures` array contains `Office Visit`, `New Patient Consultation`, and `Follow-Up` with correct durations.

---

## 4. Create Provider Accounts

Providers must be OpenEMR user accounts with the **Provider** role. `health_check_slots` generates available slots per provider.

1. Navigate to **Administration → Users**.
2. Click **Add User**.

### Provider 1 — Dr. Sarah Chen

| Field | Value |
|-------|-------|
| **Username** | `drschen` |
| **Password** | `Test1234!` |
| **First Name** | `Sarah` |
| **Last Name** | `Chen` |
| **Title** | `Dr.` |
| **User Type** | `Provider` |
| **Specialty** | `Family Medicine` |
| **NPI** | `9876543210` |
| **Facility** | `Sunridge Family Clinic` ← select from dropdown |
| **Active** | ☑ checked |

3. Click **Save**. Note the **User ID** (e.g. `2`).

### Provider 2 — Dr. Marcus Webb

| Field | Value |
|-------|-------|
| **Username** | `drmwebb` |
| **Password** | `Test1234!` |
| **First Name** | `Marcus` |
| **Last Name** | `Webb` |
| **Title** | `Dr.` |
| **User Type** | `Provider` |
| **Specialty** | `Internal Medicine` |
| **NPI** | `1122334455` |
| **Facility** | `Sunridge Family Clinic` |
| **Active** | ☑ checked |

4. After saving, note the **User ID** (e.g. `3`).

> **Important:** Both providers must be linked to the facility or `health_check_slots` will not generate slots for them.

**MCP verify:**
```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_match_provider",
    "arguments": {
      "visit_type": "Office Visit",
      "request_start_date": "2026-03-23",
      "request_end_date": "2026-03-27",
      "duration_minutes": 30,
      "max_results": 5
    }
  }}'
```
Expected: `matches` array includes Dr. Chen and Dr. Webb.

---

## 5. Configure Office Hours

Office hours are set via an environment variable in the Docker stack `.env` file, not in the OpenEMR UI.

1. Edit `docker/production/.env`:

```dotenv
OFFICE_HOURS_JSON=[
  {"day":"monday",    "open":"08:00","close":"17:00","closed":false},
  {"day":"tuesday",   "open":"08:00","close":"17:00","closed":false},
  {"day":"wednesday", "open":"08:00","close":"17:00","closed":false},
  {"day":"thursday",  "open":"08:00","close":"17:00","closed":false},
  {"day":"friday",    "open":"08:00","close":"16:00","closed":false},
  {"day":"saturday",  "open":"09:00","close":"12:00","closed":false},
  {"day":"sunday",    "open":null,   "close":null,   "closed":true}
]
```

2. Restart the MCP container:

```bash
cd docker/production
docker compose up -d openemr-mcp
```

**MCP verify:**
```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_get_office_hours",
    "arguments": { "day": "saturday" }
  }}'
```
Expected: Saturday shows `open: "09:00"`, `close: "12:00"`, `closed: false`.

---

## 6. Configure Billing Policy

Like office hours, billing policy is an environment variable.

1. Edit `docker/production/.env`:

```dotenv
BILLING_POLICY_JSON={
  "insurance": "Sunridge accepts Aetna, Blue Cross Blue Shield, Cigna, United, and Medicare. Please call to verify your specific plan.",
  "copay": "Copay is due at time of service. Office Visit: $25. Specialist: $40.",
  "cancellation": "Please cancel at least 24 hours in advance. Late cancellations or no-shows incur a $50 fee.",
  "refund": "Refunds for overpayment are processed within 7-10 business days.",
  "payment_plan": "Interest-free payment plans available for balances over $200. Contact billing at ext. 202."
}
```

2. Restart the MCP container (same command as step 5).

**MCP verify:**
```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_get_billing_policy",
    "arguments": { "topic": "cancellation" }
  }}'
```
Expected: Returns the cancellation policy text.

---

## 7. Create Test Patients

Two patients are enough to test all patient-facing tools: one with insurance, one without.

### Patient 1 — Alice Thompson (Established Patient with Insurance)

1. Navigate to **Patient** → **New/Search** (or press **F3**).
2. Click **New Patient**.
3. Fill in the **Demographics** tab:

| Field | Value |
|-------|-------|
| **First Name** | `Alice` |
| **Last Name** | `Thompson` |
| **Date of Birth** | `1978-06-14` |
| **Sex** | `Female` |
| **SSN** | `555-12-3456` |
| **Address** | `22 Maple Ave` |
| **City** | `Springfield` |
| **State** | `IL` |
| **Zip** | `62701` |
| **Home Phone** | `555-0201` |
| **Cell Phone** | `555-0202` |
| **Email** | `alice.thompson@example.com` |

4. On the **Insurance** tab, click **Add Insurance**:

| Field | Value |
|-------|-------|
| **Insurance Company** | `Blue Cross Blue Shield` |
| **Plan Name** | `Blue PPO 500` |
| **Group Number** | `GRP-88001` |
| **Member ID** | `BCB123456789` |
| **Relationship** | `Self` |
| **Subscriber First** | `Alice` |
| **Subscriber Last** | `Thompson` |
| **Subscriber DOB** | `1978-06-14` |

5. Click **Save Patient**.
6. Note the **Patient ID (PID)** from the URL or top of the page (e.g. `1`).

---

### Patient 2 — Carlos Rivera (New Patient, Self-Pay)

| Field | Value |
|-------|-------|
| **First Name** | `Carlos` |
| **Last Name** | `Rivera` |
| **Date of Birth** | `1990-11-03` |
| **Sex** | `Male` |
| **Cell Phone** | `555-0303` |
| **Email** | `carlos.rivera@example.com` |
| **Address** | `88 Oak Street, Springfield, IL 62702` |

No insurance — leave the Insurance tab blank.

Note PID (e.g. `2`).

**MCP verify (masked — no verification):**
```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_lookup_patient",
    "arguments": { "patient_email": "alice.thompson@example.com" }
  }}'
```
Expected: `patient_found: true`, `patient_verified: false`, name shown as `A***`.

**MCP verify (full — with verification):**
```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_lookup_patient",
    "arguments": {
      "patient_email": "alice.thompson@example.com",
      "verification_level": "contact"
    }
  }}'
```
Expected: Full name, phone, email, DOB returned.

---

## 8. Create a Test Appointment

A pre-existing appointment allows testing `health_list_appointments`, `health_cancel_appointment`, and `health_reschedule_appointment` without booking through the MCP first.

1. Navigate to **Modules** → **Calendar** (or click the calendar icon).
2. Navigate to a weekday next week.
3. Click on a time slot in Dr. Chen's column (e.g. Tuesday 10:00 AM).
4. In the appointment dialog:

| Field | Value |
|-------|-------|
| **Patient** | `Alice Thompson` (search and select) |
| **Provider** | `Dr. Sarah Chen` |
| **Facility** | `Sunridge Family Clinic` |
| **Category** | `Office Visit` |
| **Reason** | `Annual check-up` |
| **Status** | `-` (scheduled) |

5. Click **Save**.
6. Note the appointment `pc_eid` (shown in the URL when editing, e.g. `pc_eid=5`). The booking reference will be `emr:appt:5`.

**MCP verify:**
```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_list_appointments",
    "arguments": {
      "patient_id": "1",
      "verification_level": "contact"
    }
  }}'
```
Expected: Appointment for Alice Thompson on the date you selected.

---

## 9. Verify Everything with MCP Tools

Run each of these calls in order after completing the setup above. Each one exercises a different tool group.

### 9.1 Clinic Info Group

```bash
# Office hours — full week
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_get_office_hours","arguments":{}}}'

# Location search
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_get_location","arguments":{"query":"Sunridge"}}}'

# Billing — all topics
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_get_billing_policy","arguments":{}}}'

# Procedure catalog
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_get_procedure_catalog","arguments":{"query":"visit"}}}'
```

### 9.2 Slot Availability + Provider Matching

```bash
# Available slots — tomorrow (no provider filter → algorithmic fallback, slot_source: "algorithmic")
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_check_slots","arguments":{"date":"tomorrow","visit_type":"Office Visit"}}}'

# Available slots for Dr. Chen specifically (uses real schedule blocks if entered, slot_source: "calendar" or "algorithmic")
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_check_slots","arguments":{"date":"tomorrow","provider_id":"2","visit_type":"Office Visit"}}}'

# Provider match — next week
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_match_provider","arguments":{"visit_type":"Office Visit","request_start_date":"2026-03-23","request_end_date":"2026-03-27","duration_minutes":30,"max_results":5}}}'
```

> The `slot_source` field in the response tells you whether slots came from real OpenEMR calendar blocks (`"calendar"`) or the 08:00–17:00 algorithmic fallback (`"algorithmic"`). You will see `"calendar"` only after completing Section 11.1 below.

### 9.3 Full Booking Cycle (Hold → Confirm → Cancel)

```bash
# Step 1: Get a slot
SLOT_RESP=$(curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_check_slots","arguments":{"date":"2026-03-25","visit_type":"Office Visit"}}}')
echo "$SLOT_RESP" | grep -o '"slot_id":"[^"]*"' | head -1

# Step 2: Hold it (replace slot_id with value from step 1)
HOLD_RESP=$(curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_hold_slot","arguments":{"slot_id":"SLOT_ID_HERE","patient_id":"1","reason":"Annual check-up"}}}')
echo "$HOLD_RESP" | grep -o '"hold_id":"[^"]*"'

# Step 3: Confirm (replace hold_id)
BOOK_RESP=$(curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_confirm_booking","arguments":{"hold_id":"HOLD_ID_HERE","idempotency_key":"test-book-001","verification_level":"basic"}}}')
echo "$BOOK_RESP" | grep -o '"booking_ref":"[^"]*"'

# Step 4: List to confirm it appears
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_list_appointments","arguments":{"patient_id":"1","verification_level":"contact"}}}'

# Step 5: Cancel it (replace booking_ref)
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_cancel_appointment","arguments":{"booking_ref":"BOOKING_REF_HERE","idempotency_key":"test-cancel-001","verification_level":"contact","cancel_reason":"Testing"}}}'
```

### 9.4 Patient Operations

```bash
# New patient intake
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_new_patient_intake","arguments":{"intake":{"fname":"Test","lname":"Patient","DOB":"2000-01-15","sex":"Male","phone_cell":"555-9999","email":"test.patient@example.com"},"source":"agent","idempotency_key":"new-pt-001"}}}'

# Update patient info (requires strong verification — set verification_level: strong)
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_update_patient_info","arguments":{"patient_email":"carlos.rivera@example.com","verification_level":"strong","updates":{"email":"carlos.updated@example.com"},"idempotency_key":"upd-001"}}}'

# Collect medical history
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_collect_medical_history","arguments":{"patient_id":"2","verification_level":"strong","history":{"allergies":"Penicillin","current_medications":"None","chronic_conditions":"Hypertension","smoking":"Never"},"idempotency_key":"hist-001"}}}'
```

### 9.5 Tools That Require External Backends

These will return `precondition_failed` (HTTP 412) unless configured — confirm the error message is clear.

```bash
# Insurance verify — expects 412 if STEDI_API_KEY not set
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_verify_insurance","arguments":{"provider_npi":"9876543210","member_id":"BCB123456789","first_name":"Alice","last_name":"Thompson","date_of_birth":"1978-06-14"}}}'

# Waitlist add — expects 412 if WAITLIST_BACKEND_URL not set
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_waitlist_add","arguments":{"patient_id":"1","visit_type":"Office Visit","request_start_date":"2026-03-23","request_end_date":"2026-04-23","priority":2,"channels":{"sms":true,"voice":false,"email":true},"consent_verified":true}}}'

# Preferences — expects 412 if PREFERENCES_BACKEND_URL not set
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_patient_preferences_get","arguments":{"patient_id":"1"}}}'
```

Expected for all three: `"ok": false`, `"status": 412`, `"error.code": "precondition_failed"`.

---

## 10. Quick Test Sequence

If you just need a fast sanity check that the server is working after setup:

```bash
BASE="http://localhost:3100/mcp"
H1='-H Content-Type: application/json'
H2='-H Accept: application/json, text/event-stream'

for TOOL in health_get_office_hours health_get_location health_get_billing_policy health_get_procedure_catalog; do
  echo -n "$TOOL → "
  curl -s -X POST $BASE $H1 $H2 \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":{}}}" \
    | grep -o '"ok":[^,}]*' | head -1
done
```

All four should print `"ok": true`.

---

## Reference: Test Data Summary

| Entity | Name / Value | ID |
|--------|-------------|-----|
| Facility | Sunridge Family Clinic | `1` |
| Provider 1 | Dr. Sarah Chen | `2` |
| Provider 2 | Dr. Marcus Webb | `3` |
| Category 1 | Office Visit (30 min) | — |
| Category 2 | New Patient Consultation (60 min) | — |
| Category 3 | Follow-Up (15 min) | — |
| Patient 1 | Alice Thompson (insured) | `1` |
| Patient 2 | Carlos Rivera (self-pay) | `2` |

> IDs depend on what already exists in your OpenEMR database. The first facility created is typically ID `1`, but check the URL after saving to confirm.

---

## 11. Provider Schedules for One Year

### How Slot Generation Works (Read This First)

`health_check_slots` uses a two-path algorithm depending on whether a `provider_id` is supplied:

**Path A — Real calendar blocks (when `provider_id` is given)**

1. Calls `GET /api/provider/:id/schedule?date_start=DATE&date_end=DATE` on OpenEMR.
2. OpenEMR returns availability blocks (`pc_pid = 0` rows) entered in the calendar for that provider.
3. Slots are generated within each block's start/end window.
4. Only bookings belonging to **that provider** on that date are removed.
5. Response includes `"slot_source": "calendar"`.

**Path B — Algorithmic fallback (no `provider_id`, or provider has no calendar blocks)**

1. Fetches appointment categories and the first facility.
2. Fetches all existing appointments and filters to those matching the provider (if given) on the date.
3. Generates slots from **08:00 to 17:00** in increments of the category duration.
4. Removes start times already booked by the same provider.
5. Response includes `"slot_source": "algorithmic"`.

**What this means for testing:**
- Setting up calendar availability blocks in OpenEMR (Section 11.1) is now **the primary step** — it directly controls what windows `health_check_slots` uses.
- Without blocks, the tool falls back to 08:00–17:00. This is fine for smoke tests but gives unrealistic results for scenario testing.
- Seeding appointments (Section 11.3) creates "existing bookings" that are subtracted from whichever windows are active.
- `slot_source` in the response tells you which path was taken.

---

### 11.1 Enter Provider Availability Blocks in the OpenEMR Calendar

These calendar entries become `openemr_postcalendar_events` rows with `pc_pid = 0`. The MCP server reads them via `GET /api/provider/:id/schedule` to determine each provider's real working windows.

#### Dr. Sarah Chen — Monday / Wednesday / Friday, 08:00–16:00

1. Navigate to **Modules → Calendar**.
2. Switch to **Week** view. Use the provider filter dropdown to show Dr. Chen's column only.
3. **For each working day** (Monday, Wednesday, Friday), create an availability block:
   - Click the 08:00 slot in Dr. Chen's column.
   - In the event dialog:
     - **Event type:** `Available` (or `Office Hours` — any non-patient type)
     - **Time:** `08:00` to `16:00`
     - **Provider:** Dr. Sarah Chen
     - **Repeat:** Weekly on Mon, Wed, Fri
     - **Repeat until:** one year from today (e.g. `2027-03-21`)
   - Click **Save**.

> **Result:** OpenEMR stores one `pc_pid=0` row per occurrence. The MCP endpoint `GET /api/provider/2/schedule?date_start=2026-04-06&date_end=2026-04-06` will return this block on any Monday in range.

#### Dr. Marcus Webb — Tuesday / Thursday, 09:00–17:00

Using the same steps, create weekly recurring availability blocks for Dr. Webb on Tuesday and Thursday, 09:00–17:00, for one year.

> **Tip:** Use **Month** view to confirm blocks appear on upcoming Mondays/Tuesdays before proceeding. If you see them, the REST endpoint will return them.

**REST verify (direct — replace token and provider ID):**

```bash
TOKEN=$(curl -sk -X POST https://localhost/oauth2/default/token \
  -F grant_type=password -F client_id=$OPENEMR_CLIENT_ID \
  -F client_secret=$OPENEMR_CLIENT_SECRET \
  -F user_role=users -F username=admin -F password=pass \
  -F scope="openid api:oemr user/Appointment.read" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# Dr. Chen (ID 2) — should return blocks for this Monday
curl -sk "https://localhost/apis/default/api/provider/2/schedule?date_start=2026-04-06&date_end=2026-04-06" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: `schedule_blocks` array contains one entry with `pc_startTime: "08:00:00"` and `pc_endTime: "16:00:00"`.

**MCP verify (checks that `slot_source` is now `"calendar"`):**

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_check_slots",
    "arguments": { "date": "2026-04-06", "provider_id": "2", "visit_type": "Office Visit" }
  }}' | grep -o '"slot_source":"[^"]*"'
```

Expected: `"slot_source":"calendar"`. If you see `"algorithmic"`, the blocks were not found — re-check the provider ID and that calendar events were saved with the correct provider.

---

### 11.2 Verify the New REST Endpoint Directly

The `GET /api/provider/:pruuid/schedule` endpoint is new (added as part of the Phase 1 MCP implementation). Confirm it works before relying on it in agent tests.

```bash
# No date filter — returns all future blocks for Dr. Chen
curl -sk "https://localhost/apis/default/api/provider/2/schedule" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
blocks = d.get('data', [{}])[0].get('schedule_blocks', [])
print(f'{len(blocks)} blocks found')
if blocks:
    b = blocks[0]
    print(f'  First: {b[\"pc_eventDate\"]} {b[\"pc_startTime\"]}–{b[\"pc_endTime\"]}')
"

# Date range — Dr. Webb's Tuesday blocks for April 2026
curl -sk "https://localhost/apis/default/api/provider/3/schedule?date_start=2026-04-01&date_end=2026-04-30" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
blocks = d.get('data', [{}])[0].get('schedule_blocks', [])
print(f'Dr. Webb — April blocks: {len(blocks)}')
for b in blocks[:4]:
    print(f'  {b[\"pc_eventDate\"]} {b[\"pc_startTime\"]}–{b[\"pc_endTime\"]}')
"
```

Expected: ~4 Tuesday blocks in April for Dr. Webb (April 7, 14, 21, 28).

**Error cases to confirm:**

```bash
# Invalid UUID → 404
curl -sk "https://localhost/apis/default/api/provider/nonexistent/schedule" \
  -H "Authorization: Bearer $TOKEN"
# Expected: {"validationErrors": {"pruuid": "Provider not found: nonexistent"}}

# Bad date format → 400
curl -sk "https://localhost/apis/default/api/provider/2/schedule?date_start=04-06-2026" \
  -H "Authorization: Bearer $TOKEN"
# Expected: {"validationErrors": {"date_start": "Must be YYYY-MM-DD, got: 04-06-2026"}}
```

---

### 11.3 Seed Realistic Appointments (Bulk Script)

With availability blocks in place, seed patient appointments across both providers' schedules for one year. This creates existing bookings that `health_check_slots` will subtract from the available windows.

The `scripts/seed_schedules.py` script is provided in the repo. It uses the MCP `health_book_slot` tool directly — no database access required.

**Seeding pattern:**

| Provider | Day | Time | Patient | Visit type |
|----------|-----|------|---------|------------|
| Dr. Chen | Monday | 09:00 | Alice (P1) | Annual check-up |
| Dr. Chen | Wednesday | 10:30 | Carlos (P2) | Follow-up |
| Dr. Chen | Friday | 14:00 | Alice (P1) | Office visit |
| Dr. Chen | Friday | 15:30 | Carlos (P2) | Follow-up |
| Dr. Webb | Tuesday | 09:30 | Carlos (P2) | New patient consultation |
| Dr. Webb | Tuesday | 14:00 | Alice (P1) | Office visit |
| Dr. Webb | Thursday | 09:00 | Alice (P1) | Office visit |
| Dr. Webb | Thursday | 13:00 | Carlos (P2) | Follow-up |

**Run the script:**

```bash
# Dry-run first — prints what would be booked without making any calls
python3 scripts/seed_schedules.py --dry-run

# Live run with defaults (Dr. Chen ID=2, Dr. Webb ID=3, patients 1 and 2, facility 1)
python3 scripts/seed_schedules.py 2>&1 | tee /tmp/seed_output.log

# If your provider/category IDs differ, pass them explicitly:
python3 scripts/seed_schedules.py \
  --chen-id 2 --webb-id 3 \
  --patient1 1 --patient2 2 \
  --facility 1 \
  --cat-id 5        # ← find your Office Visit cat ID via health_get_procedure_catalog
```

Expected output: `416` lines (52 weeks × 8 appts/week), each with `✓`. Lines with `⟳` mean the appointment already exists (idempotent — safe to re-run).

> **Finding the correct category ID:** Call `health_get_procedure_catalog` via MCP or look in **Administration → Practice → Appointment Categories**. Pass the `id` field for "Office Visit" as `--cat-id`. If the wrong ID is used, bookings will fail with `✗` and the script will exit non-zero.

---

### 11.4 Verify Year-Round Slot Availability

After entering calendar blocks (11.1) and seeding appointments (11.3):

```bash
# Dr. Chen — Monday 2026-04-06 (blocks 08:00–16:00; seeded appt at 09:00)
# Expected: slots at 08:00, 09:30–15:30 — NOT 09:00. slot_source: calendar
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_check_slots",
    "arguments": { "date": "2026-04-06", "provider_id": "2", "visit_type": "Office Visit" }
  }}' | python3 -c "
import json, sys, re
raw = sys.stdin.read()
for line in raw.splitlines():
    if line.startswith(\"data:\"):
        d = json.loads(line[5:])
        r = d.get(\"result\",{}).get(\"result\",{})
        print(f'source={r.get(\"slot_source\")}  count={r.get(\"count\")}')
        for s in r.get(\"available_slots\",[])[:5]:
            print(f'  {s[\"start_time\"]}–{s[\"end_time\"]}')
"

# Dr. Webb — Tuesday 2026-04-07 (blocks 09:00–17:00; seeded appts at 09:30 and 14:00)
# Expected: 09:00, 10:00–13:30, 14:30–16:30. slot_source: calendar
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_check_slots",
    "arguments": { "date": "2026-04-07", "provider_id": "3", "visit_type": "Office Visit" }
  }}' | grep -oE '"start_time":"[^"]*"|"slot_source":"[^"]*"'

# No provider specified — algorithmic fallback, broader window
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_check_slots",
    "arguments": { "date": "2026-04-06" }
  }}' | grep -oE '"count":[0-9]+|"slot_source":"[^"]*"'

# Far-future date — 6 months out, Dr. Chen
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_check_slots",
    "arguments": { "date": "2026-09-14", "provider_id": "2", "visit_type": "Office Visit" }
  }}' | grep -oE '"count":[0-9]+|"slot_source":"[^"]*"'

# Provider match across the full year
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name": "health_match_provider",
    "arguments": {
      "visit_type": "Office Visit",
      "request_start_date": "2027-01-05",
      "request_end_date": "2027-01-31",
      "duration_minutes": 30,
      "max_results": 5
    }
  }}'
```

---

### 11.5 Scenario Reference for Agent Testing

| Scenario | Test setup | Expected agent behaviour |
|----------|-----------|--------------------------|
| **Real calendar blocks respected** | Call `health_check_slots` with `provider_id` on a work day | `slot_source: "calendar"`, slots within the block window only |
| **No blocks → fallback** | Call with `provider_id` on a day with no block (e.g. Chen on Tuesday) | `slot_source: "algorithmic"`, full 08:00–17:00 window |
| **Fully booked day** | Seed all slots within a block window | Agent offers next available date |
| **Provider preference** | Ask for Dr. Chen on a Wednesday | Agent finds open slot within 08:00–16:00, not at 10:30 |
| **Far-future booking** | Request date 6+ months out | Slots within calendar block, no conflicts unless seeded |
| **Same-day booking** | Request `today` early morning with `provider_id` | Agent books within today's availability block |
| **Reschedule across weeks** | Book a slot, then reschedule to 3 weeks later | Old slot freed, new booking confirmed in correct block |
| **Waitlist trigger** | `health_check_slots` for a fully-booked block window | Agent calls `health_waitlist_add` |
| **New patient + book** | Patient not in system; New Patient Consultation | Agent calls `health_new_patient_intake` then `health_hold_slot` + `health_confirm_booking` |
| **Cancellation close to date** | Cancel within 24 h | Agent cites the billing policy cancellation fee |

---

### 11.6 Reset / Wipe Seeded Appointments

To reset without rebuilding the full OpenEMR container:

```bash
# Delete all future patient appointments for the two test patients (keeps availability blocks)
docker compose -f docker/production/docker-compose.yml exec mysql \
  mariadb -u openemr -popenemr openemr \
  -e "DELETE FROM openemr_postcalendar_events
      WHERE pc_pid IN (1,2)
        AND pc_eventDate > CURDATE();"

# To also remove availability blocks (pc_pid=0) for both providers:
docker compose -f docker/production/docker-compose.yml exec mysql \
  mariadb -u openemr -popenemr openemr \
  -e "DELETE FROM openemr_postcalendar_events
      WHERE pc_pid = 0
        AND pc_aid IN (2,3)
        AND pc_eventDate > CURDATE();"
```

After resetting appointments, re-run the seed script:

```bash
python3 scripts/seed_schedules.py 2>&1 | tee /tmp/seed_output.log
```
