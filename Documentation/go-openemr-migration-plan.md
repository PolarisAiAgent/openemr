# go-openemr Migration Plan (Go Backend + React Frontend)

This document outlines a practical migration strategy for creating a new repository named **go-openemr** with a Go-based server and React-based frontend.

## 1) Guiding Principles

- **Do not big-bang rewrite**: use the strangler pattern and replace capabilities by domain.
- **Preserve clinical safety and correctness**: prioritize parity and strong tests for patient-facing workflows.
- **Move data model first, UI second** for high-risk areas.
- **Treat interoperability as first-class** (FHIR, HL7, CCDA, APIs).

## 2) Target Architecture

### Backend (Go)

- Language/runtime: Go 1.24+
- HTTP framework: Chi or Gin (Chi preferred for explicit middleware and low magic)
- API style:
  - External: REST + OpenAPI
  - Internal: service interfaces + domain modules
- Data access:
  - Start with SQLC (typed SQL) for reliability in a legacy schema
  - Optionally introduce GORM only where dynamic query generation is valuable
- AuthN/AuthZ:
  - OAuth2 / OIDC support
  - JWT access tokens + short session lifetimes
  - RBAC policy layer extracted from current ACL concepts
- Background work:
  - Asynq or Temporal for billing jobs, imports, notifications
- Observability:
  - OpenTelemetry tracing + Prometheus metrics + structured logs (Zap)

### Frontend (React)

- React 19 + TypeScript
- Router: React Router
- Data fetching: TanStack Query
- Form handling: React Hook Form + Zod
- UI system:
  - Design tokens + component primitives (e.g., Radix + Tailwind)
  - Accessibility checks baked into CI
- Feature organization:
  - Domain folders (patients, encounters, orders, billing, scheduling)

### Platform

- Repo: `go-openemr`
- Monorepo recommended:
  - `apps/api` (Go API)
  - `apps/web` (React app)
  - `packages/contracts` (OpenAPI/JSON schema/types)
  - `deploy` (Helm/Terraform/K8s manifests)
- CI/CD:
  - Backend lint/test/build
  - Frontend lint/test/build
  - Contract tests
  - E2E smoke on every merge

## 3) Domain-by-Domain Migration Order

Suggested order (lowest coupling and highest value first):

1. Authentication/session facade
2. Patient search + demographics read/write
3. Scheduling (appointments/calendar)
4. Encounters/notes (start with read-only, then write)
5. Orders/results
6. Billing/claims
7. Admin/configuration

For each domain, complete:

- API contract definition
- Data access abstraction
- Read parity tests
- Write path with idempotency and audit trail
- UI replacement in React
- Traffic cutover and rollback runbook

## 4) Migration Strategies

### Strategy A: Side-by-side with shared database (recommended initially)

- Keep current DB schema while building Go read/write services.
- Add anti-corruption layer in Go to isolate legacy schema quirks.
- Advantages: fastest to start, minimal data migration risk.
- Risks: legacy schema complexity leaks into new code.

### Strategy B: Event-carried migration (later)

- Publish domain events from legacy writes and Go writes.
- Gradually move selected domains to new bounded-context schemas.
- Advantages: long-term clean architecture.
- Risks: increased operational complexity.

## 5) Data and Compatibility Plan

- Freeze and version SQL schema snapshots.
- Build compatibility views where table semantics differ.
- Establish data invariants (e.g., patient merge rules, encounter status transitions).
- Add migration verification jobs:
  - record counts
  - checksums for critical fields
  - referential integrity checks

## 6) Security and Compliance

- Threat model before first production domain cutover.
- Encrypt PHI at rest and in transit.
- Implement immutable audit logs for sensitive actions.
- Enforce least privilege database roles.
- Add automated security scanning:
  - Go: `gosec`, `govulncheck`
  - Frontend: dependency audit + SAST

## 7) Testing Strategy

- **Contract tests** between React app and Go API from OpenAPI specs.
- **Golden tests** for clinical/business calculations to ensure parity.
- **Shadow reads**: compare legacy and Go responses in production-safe mode.
- **Replay tests**: anonymized production traffic replayed into staging.
- **E2E tests** for top workflows (register patient, create encounter, submit claim).

## 8) Deployment and Cutover

- Introduce API gateway/BFF layer to route by capability.
- Start with read-only endpoints behind feature flags.
- Progression:
  1. Internal dogfood
  2. Pilot tenant/site
  3. Regional rollout
  4. Full cutover
- Maintain explicit rollback criteria and switchback scripts.

## 9) Team and Execution Model

- 2-pizza cross-functional pods by domain.
- Shared platform team for auth, observability, devex, deployment.
- Weekly architecture review for standards and deviations.
- Track migration scorecard per domain:
  - API parity %
  - test coverage
  - defect escape rate
  - SLO performance

## 10) Suggested Initial 90-Day Plan

### Days 0–30

- Stand up `go-openemr` monorepo skeleton.
- Set CI, linting, observability baseline.
- Implement auth/session + patient search read APIs.
- Build React shell + routing + auth flow.

### Days 31–60

- Patient demographics write path with audit trail.
- Scheduling read/write APIs + first React domain screens.
- Add contract tests and shadow-read comparator jobs.

### Days 61–90

- Encounter read path and pilot rollout.
- Performance tuning + security hardening.
- Publish migration runbooks and operational playbooks.

## 11) Immediate Next Steps

1. Create `go-openemr` with monorepo scaffolding.
2. Export and version current API/DB contracts.
3. Pick first pilot domain (patient search + demographics).
4. Define parity acceptance criteria before coding.
5. Set a weekly cutover readiness review.

---

This plan is designed to minimize risk while allowing rapid incremental delivery. For healthcare systems, consistency, auditability, and rollback readiness are more important than pure rewrite speed.
