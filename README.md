# TICKETFLOW

A high-concurrency event ticketing platform designed around inventory correctness, concurrent reservations, asynchronous workflows and recoverable distributed transactions.

TICKETFLOW is a transformation of the original railway-booking codebase. The original TRIVIO repository remains separate and is not modified by this project.

## Current implementation status

**Phase 1 — Architecture baseline:** complete.  
**Phase 2 — Event Service:** implemented and merged into `main`.  
**Phase 2.1 — Event Service hardening:** in progress in a review branch; not yet a production-readiness claim.

The Phase 2 Event Service owns organizer access, venues, versioned venue layouts, events, occurrences, ticket types and publication events. The current hardening work adds signed gateway identity assertions, stronger validation, event/occurrence concurrency controls, database-enforced GA capacity allocations and CI coverage.

## Architecture

The target platform contains an API Gateway and nine domain services:

| Service | Port | Responsibility |
|---|---:|---|
| API Gateway | 4000 | Authentication enforcement, routing, rate limits and circuit breakers |
| User Service | 4001 | Identity, OTP, OAuth, tokens and profiles |
| Search Service | 4002 | Event discovery and search projections |
| Event Service | 4003 | Organizers, venues, events, occurrences and ticket configuration |
| Notification Service | 4004 | Email delivery, templates and retries |
| Order Service | 4005 | Purchase lifecycle, idempotency and Saga orchestration |
| Payment Service | 4006 | Payment attempts, verified webhooks and refunds |
| Inventory Service | 4007 | Seat allocation, GA capacity, holds and expiry |
| Queue Service | 4008 | Waiting room and admission tokens |
| Ticket Service | 4009 | Ticket issuance, credentials, revocation and check-in |

The remaining imported railway-domain services and frontend have not yet been transformed to TICKETFLOW contracts. Their presence in the repository does not mean those APIs are usable for event ticketing.

## Core design decisions

- **Event vs occurrence:** An Event is the catalog product; an EventOccurrence is a separately bookable date/time at one venue.
- **Assigned seating vs GA:** Assigned seating maps tickets to physical seats. GA uses an explicit capacity allocation per section.
- **Capacity correctness:** PostgreSQL is authoritative. Redis locks or cache values are never proof that a ticket is sold.
- **GA allocation:** A GA ticket type declares `sectionAllocations: [{ sectionId, capacity }]`. Its total capacity equals the sum of those allocations, and all ticket types together may not exceed the physical capacity of any section.
- **Database ownership:** Each service owns its database. Cross-service identifiers are scalar references, not cross-database foreign keys.
- **Kafka:** Critical changes use a transactional Outbox; consumers use Inbox/idempotency to tolerate at-least-once delivery.
- **Order workflow:** Order Service coordinates Inventory, Payment and Ticket operations through a Saga with explicit compensation.
- **Read models:** Search projections may be eventually consistent. Checkout must revalidate against Inventory's authoritative database.

## Implemented Event Service scope

Implemented in Phase 2:

- Organizer creation, membership and role-based access.
- Venue, section and assigned-seat configuration.
- Immutable published venue-layout snapshots.
- Event and occurrence create/update/publish/cancel workflows.
- Ticket types, integer-minor-unit pricing and sales windows.
- Transactional Outbox events for event, occurrence and layout publication.
- API Gateway proxy routes, PostgreSQL migration and CI workflow.

Phase 2.1 adds the security and data-integrity hardening described in [Event Service documentation](docs/EVENT-SERVICE.md).

Not implemented yet: real-time Inventory materialization, seat holds, GA shards and availability, Order/Saga, Payment, Queue, Ticket issuance/check-in, Search projection and customer/organizer frontend conversion. Event Service validates configured GA capacity, but does not track live sold or held quantities.

## Local development

### Prerequisites

- Node.js 22+
- npm
- Docker Engine and Docker Compose v2
- PostgreSQL 15 and Kafka (provided by Compose for local development)

### Configure local secrets

From the repository root:

```bash
cp .env.example .env
```

Replace `GATEWAY_ASSERTION_SECRET` in `.env` with a strong random secret:

```bash
openssl rand -hex 32
```

Use the same value in the API Gateway and Event Service environments. Do not commit `.env` or reuse these development credentials in production.

### Start infrastructure and Event Service

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f event-service
```

The Compose stack is for local development. It starts PostgreSQL, Redis, Kafka, supporting dashboards and the Event Service. It does not start all ten application services or provide production-grade Kafka/Redis authentication and TLS.

Ports are bound to loopback for local use. Do not expose the development stack to the public internet.

### Run Event Service on the host

```bash
cd event-service
cp .env.example .env
npm ci
npx prisma generate
npx prisma migrate deploy
npm test
npm run dev
```

For a host-run Event Service, point `DATABASE_URL` and `KAFKA_BROKER` at your local dependencies and set `GATEWAY_ASSERTION_SECRET` to the same value used by the API Gateway. The Postgres init script creates `event_service_database` on a fresh volume; create it manually if your existing volume predates that init script.

### Useful endpoints

- `GET http://localhost:4003/health` — liveness
- `GET http://localhost:4003/ready` — PostgreSQL readiness

Business and catalog endpoints require a valid signed API Gateway assertion; calling them directly without one returns 401.

## Repository map

- `api-gateway/` — API Gateway code
- `event-service/` — TICKETFLOW Event Service implementation
- `shared/constants/` — shared Kafka topic names
- `shared/utils/` — shared internal request assertion helpers
- `docs/` — architecture and implementation contracts
- `docker/` — local PostgreSQL initialization scripts

## Validation and tests

The Event Service CI workflow runs:

1. Dependency installation with `npm ci`.
2. Prisma schema validation.
3. All PostgreSQL migrations against a clean PostgreSQL 15 database.
4. JavaScript syntax checks for Event Service, API Gateway and shared code.
5. Unit tests for date/currency validation, signed gateway assertions and GA allocation rules.
6. Docker Compose configuration validation and Event Service image build.

The CI checks do not prove production readiness. Full API integration tests, high-concurrency load tests, security scanning, observability dashboards, outbox poison-event operations and production network/TLS hardening remain separate work.

## Architecture documentation

- [System architecture](docs/TICKETFLOW-ARCHITECTURE.md)
- [Domain model and business rules](docs/DOMAIN-MODEL.md)
- [Database design and data ownership](docs/DATABASE-DESIGN.md)
- [Kafka event contracts](docs/KAFKA-EVENT-CONTRACTS.md)
- [Order Saga and recovery](docs/ORDER-SAGA.md)
- [Event Service implementation](docs/EVENT-SERVICE.md)

Update the relevant documentation in the same pull request as any contract change. The docs must describe implemented behavior, not future scope as if it already exists.

## Phase 2.1 — Security and reliability hardening

The hardening PR adds signed, replay-protected Gateway assertions; API-level tests through the real Gateway and Event Service; User Service active-account validation for organizer invitations; occurrence cancellation and scheduled lifecycle transitions; transactional outbox retry/dead-letter operations; Prometheus metrics/alerts; and a production Compose overlay for private networks, Gateway-to-Event-Service mTLS, User Service HTTPS/internal-key rotation, and Kafka TLS/SASL.

All three service dependency lockfiles are refreshed on semver-compatible versions and audited in CI. The Event Service and User Service test suites run against PostgreSQL/Redis-backed CI dependencies. Manual k6 scenarios are under `load-tests/`; they should run against a disposable staging environment. The GA contention scenario exercises Event Service ticket-type capacity configuration only. It does not claim to test live Inventory Service holds or purchase throughput; Inventory Service is still a later implementation phase.

The production Compose overlay expects externally managed ingress, private networks, certificate/secret files and an independently operated Prometheus deployment. It is a hardened deployment starting point, not a turnkey production cluster.
