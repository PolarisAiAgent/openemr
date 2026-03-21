# OpenEMR Health MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that wraps OpenEMR's patient appointment system, exposing **22 canonical `health_*` tools** so an AI agent can manage appointments, patients, providers, and waitlists without touching OpenEMR directly.

Conforms to the **Health MCP Tools Specification** (`health-mcp-tools-spec.md`).

---

## Table of Contents

- [Tools](#tools)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Enabling the API](#enabling-the-api)
- [Quick Start (local / stdio)](#quick-start-local--stdio)
- [Docker Deployment](#docker-deployment)
- [Connecting Claude Code to the MCP Server](#connecting-claude-code-to-the-mcp-server)
- [Response Contract](#response-contract)
- [Persistence-Dependent Tools](#persistence-dependent-tools)
- [Project Structure](#project-structure)

---

## Tools

### Appointment operations

| Tool | Description |
|------|-------------|
| `health_check_slots` | Find available appointment slots (supports natural-language dates: `today`, `tomorrow`, `next monday`) |
| `health_book_slot` | Book a slot for a patient |
| `health_list_appointments` | List appointments; masks PHI when `patient_verified=false` |
| `health_cancel_appointment` | Cancel by `booking_ref` or `slot_id` |
| `health_reschedule_appointment` | Move an appointment to a new slot |

### Clinic info

| Tool | Description |
|------|-------------|
| `health_get_office_hours` | Office hours (from `OFFICE_HOURS_JSON` env or Mon–Fri 08:00–17:00 default) |
| `health_get_location` | Facility/location data from OpenEMR |
| `health_get_billing_policy` | Billing policy (from `BILLING_POLICY_JSON` env) |
| `health_get_procedure_catalog` | Appointment categories / procedure types |

### Patient management

| Tool | Description |
|------|-------------|
| `health_lookup_patient` | Look up by ID, phone, or email; masked unless verified |
| `health_update_patient_info` | Update demographic fields (`patient_verified` must be `true`) |
| `health_new_patient_intake` | Create a new patient record |
| `health_collect_medical_history` | Record medical history |
| `health_verify_insurance` | Eligibility check via Stedi (requires `STEDI_API_KEY`) |

### Provider matching + waitlist

| Tool | Description |
|------|-------------|
| `health_match_provider` | Match providers by visit type, date range, and preferences |
| `health_patient_preferences_upsert` | Save scheduling preferences (requires `PREFERENCES_BACKEND_URL`) |
| `health_patient_preferences_get` | Retrieve saved preferences (requires `PREFERENCES_BACKEND_URL`) |
| `health_waitlist_add` | Add to waitlist (requires `WAITLIST_BACKEND_URL`) |
| `health_waitlist_list` | List waitlist entries (requires `WAITLIST_BACKEND_URL`) |
| `health_waitlist_remove` | Remove from waitlist (requires `WAITLIST_BACKEND_URL`) |
| `health_waitlist_offer` | Send a slot offer to a waitlisted patient (requires `WAITLIST_BACKEND_URL`) |
| `health_waitlist_confirm_offer` | Accept or decline a slot offer (requires `WAITLIST_BACKEND_URL`) |

---

## Architecture

```
AI Agent (Claude / any MCP client)
        │
        │  MCP protocol (stdio or HTTP/Streamable)
        ▼
┌─────────────────────────────┐
│   OpenEMR Health MCP Server │
│   (Node.js / TypeScript)    │
│                             │
│  22 health_* tools          │
│  ├─ appointments.ts         │
│  ├─ patients.ts             │
│  ├─ clinic-info.ts          │
│  ├─ insurance.ts            │
│  ├─ provider-matching.ts    │
│  └─ waitlist.ts             │
└────────────┬────────────────┘
             │  OAuth2 + REST API
             ▼
    ┌─────────────────┐      ┌──────────────────┐
    │    OpenEMR      │      │  Stedi (optional) │
    │  (PHP / MySQL)  │      │  Insurance verify │
    └─────────────────┘      └──────────────────┘
```

### Transport modes

| Mode | When | Use case |
|------|------|----------|
| **stdio** | `MCP_PORT` not set | Claude Code CLI, local development |
| **HTTP** | `MCP_PORT=3100` | Docker, production, remote agents |

---

## Prerequisites

- **Node.js** >= 18 (for local development)
- **Docker + Docker Compose** (for containerised deployment)
- A running **OpenEMR** instance with the REST API enabled (see [Enabling the API](#enabling-the-api) below)

---

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENEMR_BASE_URL` | Base URL of your OpenEMR instance | `https://localhost:9300` |
| `OPENEMR_CLIENT_ID` | OAuth2 client ID (see registration below) | `your-client-id` |
| `OPENEMR_CLIENT_SECRET` | OAuth2 client secret | `your-client-secret` |
| `OPENEMR_USERNAME` | OpenEMR user with Appointments ACL | `admin` |
| `OPENEMR_PASSWORD` | Password for that user | `pass` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENEMR_SITE` | OpenEMR site slug | `default` |
| `MCP_PORT` | Port to listen on in HTTP mode; omit for stdio mode | *(stdio)* |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Set to `0` only for self-signed TLS within a private network | `1` |
| `OFFICE_HOURS_JSON` | JSON array of office hours (see format below) | Mon–Fri 08:00–17:00 |
| `BILLING_POLICY_JSON` | JSON object of billing policy topics | generic message |
| `STEDI_API_KEY` | Stedi API key for `health_verify_insurance` | *(tool disabled)* |
| `STEDI_ENDPOINT` | Override Stedi eligibility endpoint URL | Stedi default |
| `PREFERENCES_BACKEND_URL` | HTTP backend URL for patient preferences | *(tool returns 412)* |
| `WAITLIST_BACKEND_URL` | HTTP backend URL for waitlist operations | *(tools return 412)* |

### `OFFICE_HOURS_JSON` format

```json
[
  { "day": "monday",    "open": "09:00", "close": "17:00", "closed": false },
  { "day": "tuesday",   "open": "09:00", "close": "17:00", "closed": false },
  { "day": "wednesday", "open": "09:00", "close": "17:00", "closed": false },
  { "day": "thursday",  "open": "09:00", "close": "17:00", "closed": false },
  { "day": "friday",    "open": "09:00", "close": "17:00", "closed": false },
  { "day": "saturday",  "open": null,    "close": null,    "closed": true  },
  { "day": "sunday",    "open": null,    "close": null,    "closed": true  }
]
```

### `BILLING_POLICY_JSON` format

```json
{
  "insurance":     "We accept most major insurance plans. Please call to verify coverage.",
  "copay":         "$20 copay due at time of service.",
  "cancellation":  "Please cancel at least 24 hours in advance to avoid a $50 no-show fee.",
  "refund":        "Refunds are processed within 5–7 business days.",
  "payment_plan":  "Payment plans available. Ask our billing team for details."
}
```

---

## Enabling the API

The OpenEMR REST API must be enabled before the MCP server can authenticate.

### Admin UI (recommended)

1. Log in as admin and go to **Administration → Config**.
2. In the left sidebar, click **Connectors** (not Appearance).
3. Use the search box to find each setting — search for `rest`, `fhir`, and `site` in turn.
4. Enable the following fields:
   - **Site Address** — set to the public base URL of your OpenEMR instance (required for OAuth2 redirects)
   - **Enable OpenEMR Standard REST API** — check this box
   - **Enable OpenEMR Standard FHIR REST API** — check this box (required for some scopes)
5. Save.

### Registering an OAuth2 Client

After enabling the API, register an OAuth2 client (one-time setup). Use the UI path **Administration → Config → Connectors → OAuth2 Clients** if available, or register directly via `curl`:

```bash
curl -k -X POST https://localhost/oauth2/default/registration \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "openemr-mcp",
    "application_type": "private",
    "redirect_uris": ["https://localhost/swagger/oauth2-redirect.html"],
    "grant_types": ["password", "refresh_token"],
    "token_endpoint_auth_method": "client_secret_post",
    "scope": "openid api:oemr user/Patient.read user/Appointment.read user/Appointment.write"
  }'
```

> **Note:** Replace `https://localhost` with your actual OpenEMR base URL. The `-k` flag bypasses TLS verification for self-signed certificates — omit it in production.

The response contains `client_id` and `client_secret`. Copy them into your `.env` (or Docker `.env`):

```dotenv
OPENEMR_CLIENT_ID=<client_id from response>
OPENEMR_CLIENT_SECRET=<client_secret from response>
```

---

## Quick Start (local / stdio)

```bash
cd mcp-server

# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Configure (copy and edit)
cp .env.example .env
# Set OPENEMR_BASE_URL, OPENEMR_CLIENT_ID, OPENEMR_CLIENT_SECRET,
# OPENEMR_USERNAME, OPENEMR_PASSWORD in .env

# 4. Run in stdio mode (used by Claude Code CLI as a subprocess)
node dist/index.js

# 5. Or inspect with the MCP inspector UI
npm run inspect
```

### Register with Claude Code (stdio)

```bash
claude mcp add --scope project --transport stdio openemr-health \
  -- node /path/to/openemr/mcp-server/dist/index.js
```

With environment variables passed inline:

```bash
claude mcp add --scope project --transport stdio openemr-health \
  --env OPENEMR_BASE_URL=https://localhost:9300 \
  --env OPENEMR_CLIENT_ID=your-id \
  --env OPENEMR_CLIENT_SECRET=your-secret \
  --env OPENEMR_USERNAME=admin \
  --env OPENEMR_PASSWORD=pass \
  -- node /path/to/openemr/mcp-server/dist/index.js
```

---

## Docker Deployment

The MCP server runs as a sidecar alongside OpenEMR using the production Docker Compose stack.

### 1. Configure secrets

```bash
cd docker/production
cp .env.example .env
```

Edit `.env` and fill in:

```dotenv
# OAuth2 client (from registration step above)
OPENEMR_CLIENT_ID=your-client-id
OPENEMR_CLIENT_SECRET=your-client-secret

# OpenEMR service account
OPENEMR_MCP_USER=admin
OPENEMR_MCP_PASS=pass

# Optional — insurance verification
STEDI_API_KEY=

# Optional — persistence backends
WAITLIST_BACKEND_URL=
PREFERENCES_BACKEND_URL=

# Optional — clinic configuration
OFFICE_HOURS_JSON=
BILLING_POLICY_JSON=
```

### 2. Build and start

```bash
cd docker/production
docker compose up --build --detach
```

This starts three services:

| Service | Port | Description |
|---------|------|-------------|
| `mysql` | — | MariaDB 11.8 (internal only) |
| `openemr` | 80, 443 | OpenEMR application |
| `openemr-mcp` | **3100** | Health MCP server |

The `openemr-mcp` service waits for `openemr` to pass its healthcheck before starting.

### 3. Verify

```bash
# MCP server health
curl http://localhost:3100/health
# {"status":"ok","tools":22,"server":"openemr-health-mcp"}

# View logs
docker compose logs -f openemr-mcp
```

### 4. Register with Claude Code (HTTP mode)

```bash
claude mcp add --transport http openemr-health http://localhost:3100/mcp
```

Or add to `.mcp.json` in your project root to share with the team:

```json
{
  "mcpServers": {
    "openemr-health": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### Building the image separately

```bash
# Build the MCP server image
docker build -t openemr-health-mcp:latest ./mcp-server

# Run standalone (stdio mode)
docker run --rm -i \
  -e OPENEMR_BASE_URL=https://your-openemr-host \
  -e OPENEMR_CLIENT_ID=your-id \
  -e OPENEMR_CLIENT_SECRET=your-secret \
  -e OPENEMR_USERNAME=admin \
  -e OPENEMR_PASSWORD=pass \
  openemr-health-mcp:latest

# Run standalone (HTTP mode)
docker run --rm -p 3100:3100 \
  -e MCP_PORT=3100 \
  -e OPENEMR_BASE_URL=https://your-openemr-host \
  -e OPENEMR_CLIENT_ID=your-id \
  -e OPENEMR_CLIENT_SECRET=your-secret \
  -e OPENEMR_USERNAME=admin \
  -e OPENEMR_PASSWORD=pass \
  openemr-health-mcp:latest
```

---

## Connecting Claude Code to the MCP Server

### stdio (local development)

```bash
claude mcp add --scope project --transport stdio openemr-health \
  -- node ./mcp-server/dist/index.js
```

### HTTP (Docker / remote)

```bash
claude mcp add --transport http openemr-health http://localhost:3100/mcp
```

### Verify tools are loaded

```
/mcp
```

You should see all 22 `health_*` tools listed.

---

## Response Contract

Every tool returns a normalized envelope:

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

Errors use canonical codes:

```json
{
  "ok": false,
  "status": 400,
  "result": {
    "status": "error",
    "error": {
      "code": "invalid_request",
      "message": "slot_id is required",
      "retryable": false
    }
  },
  "meta": { "tool": "health_book_slot", "provider": "openemr", "elapsed_ms": 1 }
}
```

| `error.code` | HTTP status | Meaning |
|---|---|---|
| `invalid_request` | 400 | Missing or invalid input |
| `not_found` | 404 | Resource does not exist |
| `conflict` | 409 | Duplicate / scheduling conflict |
| `precondition_failed` | 412 | Verification required or backend not configured |
| `provider_error` | 502 | OpenEMR / Stedi returned an error |
| `timeout` | 504 | Upstream timed out |
| `internal_error` | 500 | Unexpected server error |

---

## Persistence-Dependent Tools

The following tools require an external HTTP backend to persist state. When the corresponding environment variable is not set they return `precondition_failed` (HTTP 412) — no data is lost, the tool simply indicates it is not yet configured.

| Tools | Required env var |
|-------|-----------------|
| `health_waitlist_*` (5 tools) | `WAITLIST_BACKEND_URL` |
| `health_patient_preferences_upsert/get` | `PREFERENCES_BACKEND_URL` |

The backends must expose simple REST endpoints:
- `POST /waitlist`, `GET /waitlist`, `DELETE /waitlist/:id`, `POST /waitlist/:id/offer`, `POST /offers/:id/confirm`
- `GET /preferences/:patient_id`, `PUT /preferences/:patient_id`

---

## Project Structure

```
mcp-server/
├── Dockerfile                 # Multi-stage build (builder → runtime, non-root)
├── .dockerignore
├── .env.example               # Template for required secrets
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts               # Entry point — registers all 22 tools; stdio or HTTP transport
    ├── auth.ts                # OAuth2 password-grant token management (auto-refresh)
    ├── openemr-client.ts      # Authenticated HTTP client for OpenEMR REST API
    ├── response.ts            # Canonical response/error builders
    ├── utils/
    │   ├── date.ts            # Natural-language date resolution
    │   └── slot.ts            # Slot ID encoding/decoding (emr:{date}:{HHmm}:...)
    └── tools/
        ├── appointments.ts    # health_check_slots, health_book_slot, health_list_appointments,
        │                      #   health_cancel_appointment, health_reschedule_appointment
        ├── patients.ts        # health_lookup_patient, health_update_patient_info,
        │                      #   health_new_patient_intake, health_collect_medical_history
        ├── clinic-info.ts     # health_get_office_hours, health_get_location,
        │                      #   health_get_billing_policy, health_get_procedure_catalog
        ├── insurance.ts       # health_verify_insurance (Stedi)
        ├── provider-matching.ts # health_match_provider, health_patient_preferences_*
        └── waitlist.ts        # health_waitlist_add/list/remove/offer/confirm_offer
```
