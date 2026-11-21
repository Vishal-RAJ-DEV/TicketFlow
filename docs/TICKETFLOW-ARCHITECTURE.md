# TICKETFLOW — System Architecture

**Status:** Target architecture baseline; Event Service implementation is in Phase 2  
**Repository:** Vishal-RAJ-DEV/TicketFlow  
**Last updated:** 2026-11-21  
**Scope:** Architecture/documentation only. Target application services are not yet implemented by this document.

## 1. Product and engineering objective

TICKETFLOW is a multi-organizer ticketing platform for concerts, sports, comedy, festivals and conferences. Customers discover an event occurrence, join a controlled sale flow when required, reserve assigned seats or general-admission capacity, pay, receive digital tickets and present them at a gate. Organizers manage events, venues, ticket types and sale windows. Gate operators validate tickets and record entry.

The engineering objective is correctness under contention and recoverability across independent services—not maximizing the number of microservices.

Core invariants:
1. An assigned seat cannot be held or sold by two customers simultaneously.
2. General-admission held plus sold quantity never exceeds configured capacity.
3. A completed order has confirmed inventory and an issued ticket batch.
4. Tickets cannot be issued from payment success alone.
5. A ticket can be checked in at most once.
6. Duplicate API requests, provider webhooks and Kafka messages do not duplicate business effects.
7. A captured payment that cannot be fulfilled is reconciled, normally through an idempotent refund.

## 2. Scope and non-goals

### In scope
- Organizer, event, venue, occurrence and ticket-type management.
- Assigned-seat and general-admission inventory.
- High-demand waiting room and controlled admission.
- Order orchestration, payment, refunds and compensation.
- Digital ticket issuance and QR check-in.
- Event discovery and eventually consistent search projections.
- Outbox/inbox messaging, idempotency, recovery and observability.
- Load tests proving measured throughput, latency and correctness.

### Not in the first vertical slice
- Ticket resale/transfers, auctions or a secondary marketplace.
- Offline gate scanning with multi-gate conflict-free synchronization.
- Multi-region active-active writes.
- Automatic database sharding before measurements justify it.
- A separate Venue Service; venue/layout initially belongs to Event Service.
- Complex tax jurisdictions and organizer settlement splits.

## 3. Architectural principles

- **Database per service:** Each service owns its database and is its only writer. Local development may use one PostgreSQL server with separate databases and credentials; production may deploy databases independently.
- **No cross-service foreign keys or direct database access:** External IDs are scalar references. Owners publish events or expose authenticated internal APIs.
- **PostgreSQL is authoritative for purchases:** Inventory decisions commit in Inventory Service's database. Redis supports queueing, caching, rate limits and optional contention reduction; a Redis key alone never proves a ticket is sold.
- **Commands and facts are different:** Use internal APIs for commands requiring an immediate result (create/confirm/release hold). Use Kafka for committed facts and asynchronous projections/work.
- **Transactional Outbox + Inbox:** The business write and outgoing event record commit in one local transaction. Consumers deduplicate event IDs in the same transaction as their local change.
- **At-least-once delivery with idempotent effects:** Do not claim end-to-end exactly-once processing across PostgreSQL, Kafka, Redis and a payment provider.
- **Bounded ownership:** Event owns catalog configuration; Inventory owns allocation; Order owns purchase process; Payment owns provider transactions; Ticket owns credentials/check-in.
- **Measure before scaling:** Start with constraints, indexes, connection pooling, backpressure and load tests. Add replicas, partitions or shards only when data supports them.

## 4. Target service topology

The target has ten deployable application services: API Gateway plus nine domain services.

| Service | Local port | Responsibility | Owned state |
|---|---:|---|---|
| API Gateway | 4000 | Entry point, routing, auth enforcement, rate limits, circuit breakers | No business DB |
| User Service | 4001 | Identity, OTP, OAuth, tokens, profile | user_db |
| Search Service | 4002 | Event search/discovery projection | Elasticsearch |
| Event Service | 4003 | Organizers, events, venues, layouts, occurrences, ticket configuration | event_db |
| Notification Service | 4004 | Email delivery, templates, retry history | notification_db |
| Order Service | 4005 | Order lifecycle, Saga, idempotency, recovery | order_db |
| Payment Service | 4006 | Payment attempts, verified webhooks, refunds, audit | payment_db |
| Inventory Service | 4007 | Assigned seats, GA capacity shards, holds, confirmation/expiry | inventory_db |
| Queue Service | 4008 | Waiting room, admission rate, single-use admission tokens | Redis operational state |
| Ticket Service | 4009 | Ticket issuance, credentials, revocation, gate check-in | ticket_db |

Venue remains part of Event Service initially. Extract only if independent ownership, deployment or scaling becomes justified.

~~~mermaid
flowchart TB
  C[Customer / Organizer / Gate App] --> GW[API Gateway]
  GW --> U[User Service]
  GW --> S[Search Service]
  GW --> E[Event Service]
  GW --> Q[Queue Service]
  GW --> I[Inventory Service]
  GW --> O[Order Service]
  GW --> T[Ticket Service]

  O <-->|Internal commands| I
  O <-->|Internal commands| P[Payment Service]
  E -->|Catalog events| K[(Kafka)]
  I -->|Inventory events| K
  P -->|Payment/refund events| K
  O -->|Order events| K
  T -->|Ticket events| K
  K --> S
  K --> O
  K --> T
  K --> N[Notification Service]

  U --> UDB[(user_db)]
  E --> EDB[(event_db)]
  I --> IDB[(inventory_db)]
  O --> ODB[(order_db)]
  P --> PDB[(payment_db)]
  T --> TDB[(ticket_db)]
  N --> NDB[(notification_db)]
  S --> ES[(Elasticsearch)]
  Q --> R[(Redis)]
  GW --> R
~~~

Kafka is a message backbone, not a shared database. Each service owns its own state transitions.

## 5. Mapping the imported TRIVIO codebase

TRIVIO remains in its own repository. This TicketFlow repository contains the imported TRIVIO codebase and is the only repository targeted for this transformation.

| Current directory | Target responsibility | Planned treatment |
|---|---|---|
| api-gateway | API Gateway | Retain foundation; update routes/access policy |
| user-service | User Service | Retain authentication foundation |
| admin-service | Event Service | Implemented in Phase 2 under `event-service/`, reusing the Express/Prisma/Kafka foundation and replacing railway entities |
| search-service | Search Service | Retain Elasticsearch integration patterns; rebuild event projection |
| booking-service | Order Service | Retain Saga/idempotency/CAS patterns; rewrite booking domain |
| inventory-service | Inventory Service | Retain transaction/concurrency foundations; replace schedule/segment logic |
| payment-service | Payment Service | Retain Razorpay/webhook/refund foundations; use order references |
| notification-service | Notification Service | Retain Kafka/email foundation; add event/ticket templates |
| — | Queue Service | New service |
| — | Ticket Service | New service |

Do not overwrite the TRIVIO repository. In this repository, migrate in reviewable phases. The inherited README, routes, Prisma schemas and frontend remain railway code until their respective implementation phases replace them.

## 6. Service ownership

- **Event Service:** source of truth for event metadata, organizer access, venue layout, occurrence schedule, ticket types, price, currency, sales windows and layout version.
- **Inventory Service:** source of truth for occurrence-specific allocation and hold state. It materializes published venue/ticket configuration but does not own catalog descriptions.
- **Order Service:** source of truth for purchase intent, state, price snapshot, Saga progress and compensation.
- **Payment Service:** source of truth for provider order/payment/refund state and verified webhook receipts.
- **Ticket Service:** source of truth for issued credential status and check-in.
- **Search Service:** rebuildable, eventually consistent projection. Search results never guarantee inventory.
- **Queue Service:** short-lived admission state. It does not reserve or sell tickets.
- **User Service:** identity. Organizer membership is owned by Event Service; gate permission is scoped to the event/venue.

## 7. Principal flows

### Event publication
1. Organizer creates event, venue configuration and occurrences.
2. Event Service validates and persists the catalog.
3. Event Service writes a catalog event to its outbox in the same transaction.
4. Inventory Service consumes occurrence publication and creates an idempotent inventory snapshot using layoutVersion.
5. Search Service updates Elasticsearch.
6. Queue Service may enable a waiting room for the occurrence according to sale policy.

### Purchase
1. Customer authenticates and joins the waiting room when enabled.
2. Queue Service issues an admission token bound to user and occurrence.
3. Order Service creates an idempotent order.
4. Order Service redeems the token and requests an inventory hold.
5. Inventory Service commits an all-or-nothing seat/GA hold in PostgreSQL and returns hold ID/expiry.
6. Order Service requests a payment attempt.
7. Payment Service verifies the provider webhook and emits a committed payment event.
8. Order Service asks Inventory Service to confirm the still-valid hold.
9. Order Service emits order.inventory-confirmed after the inventory commit.
10. Ticket Service issues credentials idempotently and emits ticket.issued.
11. Order Service completes the order after issuance confirmation; Notification Service delivers tickets.

### Gate check-in
1. Gate operator authenticates with event/venue-scoped permission.
2. Scanner submits the opaque ticket credential.
3. Ticket Service validates credential, occurrence and state.
4. Ticket Service atomically changes ISSUED to CHECKED_IN.
5. A duplicate scan is rejected and audited.

## 8. Inventory and concurrency

### Assigned seats
- One Inventory Service row represents one physical seat for one occurrence.
- Unique constraint: occurrenceId + venueSeatId.
- Lock requested rows in deterministic sorted order and validate all before commit.
- Change every requested seat AVAILABLE to HELD or change none.
- Confirmation changes HELD to SOLD only while the hold is ACTIVE and unexpired according to database time.
- Release/expiry changes only rows still owned by that hold.

### General admission
- Capacity is split into independent TicketPoolShard rows per occurrence/ticket type.
- Each shard enforces heldQuantity + soldQuantity <= capacity.
- Allocate quantity using conditional SQL and row locks; a zero-row update means capacity was not acquired.
- Multi-shard allocations commit in one Inventory transaction.
- Sum of shard capacities equals configured ticket capacity.

### Redis's role
Redis supports advisory locks, waiting-room sorted sets, admission-token state, cache and rate limits. PostgreSQL remains the final arbiter. If Redis is unavailable while a sale requires queueing, pause/fail closed for new admission; do not bypass the queue.

## 9. Reliability and recovery

- All critical event producers use Transactional Outbox.
- Stateful consumers use Inbox deduplication.
- Kafka offsets are committed only after local DB transaction commits.
- Retry transient errors with bounded exponential backoff and jitter.
- Send poison messages to service-specific DLQ with event ID, topic, partition, offset and failure metadata.
- DLQ replay is an audited operator workflow and preserves original event ID.
- Order Service recovery worker scans incomplete Saga steps.
- Inventory Service owns its hold-expiration worker.
- Payment/order reconciliation compares provider records, payment attempts, orders and inventory holds.
- Captured payment without confirmable inventory triggers refund compensation; it never creates a ticket.

## 10. Security and operations

- Enforce authentication at Gateway and authorization in the owning service.
- Organizer APIs verify membership/role for the target organizer.
- Gate credentials are scoped to event/venue and least privilege.
- Admission tokens are short-lived, signed, user/occurrence-bound and single-use.
- QR payloads contain opaque credentials, not PII or payment data.
- Verify provider signatures on the exact raw webhook body.
- Use service-specific credentials or workload identity in production; avoid a permanent shared internal secret.
- Use secrets management and rotation.
- Propagate request, correlation and trace IDs in structured logs.
- Add OpenTelemetry traces, Prometheus metrics and Grafana dashboards.

## 11. Scaling approach

Scale in this order:
1. Correct transactions, constraints and indexes.
2. Connection pooling and query profiling.
3. Redis caching for browse/read paths.
4. Queue admission and backpressure for high-demand occurrences.
5. Kafka partitioning by business aggregate key.
6. Search projection and suitable read replicas.
7. Partition large historical tables and archive cold data.
8. GA allocation shards and, only if measured, dedicated high-demand partitions/database shards.

Avoid a single global per-occurrence counter on every purchase. Availability projections can be stale; checkout verifies inventory against Inventory Service.

## 12. Observability and acceptance

Measure order p50/p95/p99 latency, inventory hold success/conflict rate, oversell violations (target zero), queue depth/wait time, webhook latency, Kafka lag/DLQ volume, oldest unpublished outbox age, expiry backlog, ticket issuance delay, duplicate check-ins, PostgreSQL lock wait and pool saturation.

Capacity targets must be established from baseline load tests and recorded with hardware, dataset and workload. Do not claim a user count without measurements.

## 13. Implementation sequence

1. **Phase 1 — Architecture baseline:** these five documents only; no application code changes.
2. **Phase 2 — Event domain:** Event Service schema, migrations, organizer authorization, venue/layout, occurrence APIs.
3. **Phase 3 — Inventory foundation:** occurrence materialization, assigned-seat holds, GA shards, atomic confirmation/release/expiry, inbox/outbox and concurrency tests.
4. **Phase 4 — Order and Payment Saga:** order models, idempotency, payment attempts, verified webhook events, compensation and recovery.
5. **Phase 5 — Ticketing:** issuance, credential validation, revocation and atomic check-in.
6. **Phase 6 — Queue:** Redis waiting room, token redemption, controlled admission and overload behaviour.
7. **Phase 7 — Search and frontend:** event discovery, seat map, organizer workflow and customer purchase flow.
8. **Phase 8 — Production hardening:** observability, chaos/failure tests, load tests, reconciliation, security and deployment.

Each phase has schema migrations, unit/integration tests, API contracts, operational notes and a completion report before the next begins.

## 14. Product decisions to confirm later

Organizer verification; refund/cancellation rules and cutoffs; ticket transfer/resale; queue enablement rules; capture versus authorize-then-capture; online/offline gate assumptions; tax/fee calculation; organizer settlement. These do not block the architecture baseline, but must be decided before implementing the related features.

## 15. Phase 1 exit criteria

All five architecture documents are committed to TicketFlow; terminology, service ownership and workflows are consistent; TRIVIO remains untouched; application implementation has not started prematurely.
