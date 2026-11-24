# TICKETFLOW Event Service

**Status:** Phase 2 implemented; Phase 2.1 hardening in progress  
**Port:** 4003  
**Database:** `event_service_database`  
**Runtime style:** CommonJS, Express 5, Prisma 7, PostgreSQL adapter, Winston and KafkaJS

The Event Service owns organizer access, venue configuration, immutable published venue-layout snapshots, event catalog metadata, event occurrences, ticket-type configuration and prices. It does not own real-time inventory, seat holds, orders, payments or issued tickets.

## 1. Reused foundation

The service follows the existing imported service conventions:

- Express application with controller → service → Prisma layering.
- `asyncHandler` for asynchronous controller errors.
- Shared-style `AppError` hierarchy and centralized error middleware.
- Winston structured service logger.
- Prisma PostgreSQL driver adapter and one service-owned Prisma client.
- KafkaJS producer with retries.
- API Gateway-signed request assertions verified by Event Service.

Railway-specific station, train, route and schedule models/controllers are not retained in the new Event Service domain.

## 2. Ownership and entity relationships

- `Organizer.ownerId` and `OrganizerMember.userId` are scalar references to User Service IDs. There is no cross-database foreign key.
- `Organizer` owns its venues and events.
- `Venue` owns sections and a sequence of layout versions.
- `VenueSection` is either `ASSIGNED` or `GENERAL_ADMISSION`.
- `VenueSeat` belongs to an assigned section.
- `VenueLayoutVersion` stores an immutable JSON snapshot of active sections, seats and GA section capacities at publication time.
- `Event` belongs to an organizer and can have multiple occurrences.
- `EventOccurrence` has one venue, one published layout version, a date/time window and its own ticket types.
- `TicketType` belongs to one occurrence, stores a price in integer minor units, and references eligible venue sections.

The current schema and initial migration are the source of truth:

- `event-service/prisma/schema.prisma`
- `event-service/prisma/migrations/20261121140000_event_service_init/migration.sql`

### Pricing and timestamps

Prices use `BigInt` `priceMinorUnits` (for example, INR 499.00 is `49900`). API responses serialize that value as a string so JSON serialization cannot lose integer precision. Requests should send a non-negative integer or integer string. Floating-point currency values are rejected.

Date-time inputs must be ISO-8601 values that include `Z` or an explicit UTC offset. Venue timezone is stored as an IANA timezone for organizer display and local-time interpretation.

## 3. Venue layout versioning

New venues start with layout version 1 in `DRAFT`.

1. Create sections and, for assigned sections, seats while a draft layout exists.
2. Publish the draft layout.
3. The service captures all active sections and seats into `VenueLayoutVersion.snapshot`.
4. The service writes `venue.layout-version-published` to the transactional outbox in the same PostgreSQL transaction.
5. Later layout edits require creating a new draft version first. Section/seat mutation transactions lock that draft-version row, and publication takes the same lock before capturing the snapshot; the two operations cannot race. The previous version's snapshot remains unchanged.

A layout cannot be published when it contains no active sections, an assigned section has no active seats, a general-admission section has individual seats, or a GA section has no positive configured capacity.

The relational section/seat rows represent the venue's current editable layout; the published JSON snapshot preserves the exact historic layout referenced by an occurrence. Consumers must use the snapshot and layout-version ID from the occurrence publication event rather than reading a mutable current venue map.

## 4. Event and occurrence lifecycle

### Event

`DRAFT → PUBLISHED → CANCELLED`  
`PUBLISHED → COMPLETED` is reserved for lifecycle completion workflows.

An event cannot be published without at least one occurrence. Each occurrence must already reference a published layout and have at least one active ticket type. Only active, valid configurations should be exposed in customer catalog responses.

Event publication writes `event.published`. Updates to an already published event write `event.updated`. Cancellation changes non-terminal occurrences to `CANCELLED` and writes `event.cancelled`.

### Occurrence

`DRAFT → SCHEDULED` (sale window is in the future)  
`DRAFT → ON_SALE` (sale window is already open)

An occurrence can be created only using a venue owned by the same organizer as the event. Creation locks the parent event row to serialize with event cancellation, then locks the venue row before checking for overlapping non-cancelled occurrences. Rescheduling locks the occurrence and destination venue rows. Concurrent writes through Event Service cannot reserve the same venue time window. An occurrence can be published only after its parent event is published, its venue is active, its selected layout snapshot is published, its start/end/sales windows are valid, and at least one active ticket type is configured.

Occurrence publication writes `event.occurrence-published` with the event, venue, layout snapshot, ticket types, eligible section IDs, money and time configuration. That event is the future Inventory Service materialization contract. It does not create or reserve inventory in Phase 2.

The current implementation records the initial `SCHEDULED` or `ON_SALE` state at publication time. Inventory must independently enforce `salesStartsAt` / `salesEndsAt` timestamps; it must not trust a stale catalog status as an allocation guarantee.

## 5. Ticket type rules

- Ticket types are configured per occurrence, so tour dates may have different prices. Ticket-type create/update/status changes lock the occurrence row, and occurrence publication takes the same lock before reading the configuration; publication therefore emits one consistent pricing/section snapshot.
- All ticket types for one occurrence must use the same currency.
- `GENERAL_ADMISSION` uses explicit `sectionAllocations: [{ sectionId, capacity }]`. Each GA section has a finite capacity captured in its immutable layout snapshot.
- A GA ticket type's `capacity` equals the sum of its per-section allocations. The combined allocations of all non-archived ticket types targeting one section cannot exceed that section's capacity.
- `ASSIGNED` does not store an independent capacity; its eligible sections must contain seats and the ticket type has no GA capacity allocations.
- Eligible section IDs must exist in the occurrence's published layout snapshot and match the ticket type mode.
- `minPerOrder` and `maxPerOrder` must be positive and max cannot be lower than min.
- Ticket-type sales windows must be contained within the occurrence sales window.
- Ticket type name, price, capacity, section allocations and sales windows are immutable after occurrence publication.
- OWNER and ADMIN members can pause or resume a published ticket type while its occurrence is `SCHEDULED` or `ON_SALE`. Only `ACTIVE ↔ PAUSED` is allowed after publication; `ARCHIVED` remains a pre-publication configuration state.
- A published status change increments the ticket-type version and writes `event.ticket-type-status-changed` to the transactional outbox in the same transaction. Repeating the current status is idempotent and emits no duplicate event.

Event Service is authoritative for configured prices and sales rules. Inventory Service will materialize this configuration and own current availability, holds and sold quantities in a later phase.

## 6. Organizer authorization

The API Gateway validates the access token, removes caller-supplied identity/assertion headers and signs a short-lived HMAC-SHA256 assertion containing the HTTP method, downstream path/query, authenticated user ID and request-body digest. Event Service validates the timestamp and signature with constant-time comparison before setting `req.user`; organizer ownership and membership are still checked by Event Service against its own tables.

| Role | Read | Edit catalog | Manage members / cancel event |
|---|---:|---:|---:|
| OWNER | Yes | Yes | Yes |
| ADMIN | Yes | Yes | Yes |
| EDITOR | Yes | Yes | No |
| VIEWER | Yes | No | No |

Creating an organizer sets the authenticated user as its owner. The User Service remains the source of identity; organizer membership is owned here.

Direct Event Service business-route calls without a valid assertion are rejected. The assertion has a 30-second clock-skew window and includes a cryptographically random nonce. Event Service records each nonce under a database uniqueness constraint, preventing replay across multiple replicas; nonce rows older than 60 seconds are pruned opportunistically. The HMAC contract is an internal trust boundary, not a substitute for network isolation: use private service networking and TLS, store the shared secret in a secret manager, rotate it, and do not expose port 4003 publicly. Plan key rotation as a coordinated Gateway/Event Service change.

## 7. API endpoints

All authenticated routes require the gateway JWT and organizer-level authorization. Public catalog routes do not require a user token.

| Method | Event Service path | Description |
|---|---|---|
| POST | `/organizers` | Create organizer |
| GET | `/organizers` | List current user's organizers |
| GET/PATCH | `/organizers/:organizerId` | Read/update organizer |
| GET | `/organizers/:organizerId/members` | List organizer members |
| PUT/DELETE | `/organizers/:organizerId/members/:memberUserId` | Add/update or remove member |
| POST/GET | `/venues/organizers/:organizerId` | Create/list organizer venues |
| GET/PATCH | `/venues/:venueId` | Read/update venue |
| POST/GET | `/venues/:venueId/layout-versions` | Create/list layout versions |
| POST | `/venues/:venueId/layout-versions/:layoutVersionId/publish` | Publish a layout snapshot |
| POST/GET | `/venues/:venueId/sections` | Create/list sections |
| PATCH/DELETE | `/venues/:venueId/sections/:sectionId` | Update/deactivate section |
| POST | `/venues/:venueId/sections/:sectionId/seats` | Add seats in a batch (max 500 per request) |
| PATCH/DELETE | `/venues/:venueId/sections/:sectionId/seats/:seatId` | Update/deactivate seat |
| POST/GET | `/events/organizers/:organizerId` | Create/list organizer events |
| GET/PATCH | `/events/:eventId` | Read/update event |
| POST | `/events/:eventId/publish` | Publish event |
| POST | `/events/:eventId/cancel` | Cancel event |
| POST/GET | `/occurrences/events/:eventId` | Create/list event occurrences |
| GET/PATCH | `/occurrences/:occurrenceId` | Read/update occurrence |
| POST | `/occurrences/:occurrenceId/publish` | Publish occurrence |
| POST/GET | `/ticket-types/occurrences/:occurrenceId` | Create/list ticket types |
| PATCH | `/ticket-types/:ticketTypeId` | Update draft ticket type |
| PATCH | `/ticket-types/:ticketTypeId/status` | Change draft status or pause/resume a published ticket type |
| GET | `/catalog` | Public published-event catalog |
| GET | `/catalog/:slug` | Public event detail |

Through API Gateway, prepend `/api/events` to the Event Service path. For example:

- `POST /api/events/organizers`
- `POST /api/events/venues/organizers/:organizerId`
- `POST /api/events/events/organizers/:organizerId`
- `GET /api/events/catalog`

Gateway route prefixes are intentionally shaped so its existing proxy strips the first `/events` component and forwards the remaining path unchanged to Event Service.

## 8. Kafka events and Outbox delivery

| Topic | When written | Aggregate key |
|---|---|---|
| `event.published` | Event is published | Event ID |
| `event.updated` | Published event metadata changes | Event ID |
| `event.cancelled` | Organizer cancels an event | Event ID |
| `event.occurrence-published` | Occurrence is published | Occurrence ID |
| `venue.layout-version-published` | Layout snapshot is published | Layout version ID |
| `event.ticket-type-status-changed` | Published ticket type is paused or resumed | Ticket type ID |

Each event uses the shared envelope with `eventId`, `eventType`, `eventVersion`, `occurredAt`, `producer`, `aggregate` and `data`.

The source database update and outbox insert commit in one Prisma transaction. A worker claims due outbox records using PostgreSQL `FOR UPDATE SKIP LOCKED`, sends to Kafka, then marks the record published. On failure it records the error, releases the claim and schedules bounded exponential retry with jitter. Delivery is at-least-once. The hardening implementation adds pending-age/attempt metrics, protected operations endpoints for status and dead-letter inspection/retry, and Prometheus alert rules. The Prometheus server and alert delivery infrastructure remain externally operated; see sections 12–13.

Kafka delivery remains at-least-once: a process may crash after Kafka acknowledgement but before the database records `publishedAt`. Downstream consumers must deduplicate using `eventId` / Inbox records. The local Compose broker auto-creates topics for development; production topics, partitions, replication and ACLs must be provisioned explicitly.

## 9. Local development

From the repository root:

```bash
docker compose up -d --build
docker compose logs -f event-service
```

For a host-run service, create `event-service/.env` from `.env.example`, ensure the PostgreSQL database and Kafka broker are reachable, and run:

```bash
cd event-service
npm ci
npx prisma generate
npx prisma migrate deploy
npm test
npm run dev
```

The Postgres init script creates `event_service_database` on a fresh volume. If the existing `postgres_data` volume predates that init script, create the database manually before starting Event Service.

## 10. Phase 2 boundaries / known gaps

Implemented in this phase: catalog/configuration ownership, organizer membership, venues/sections/seats, immutable layout snapshots, event/occurrence/ticket-type APIs, initial PostgreSQL migration, gateway integration and Outbox publication.

Not implemented here: inventory materialization/availability, seat locking/holds, GA runtime shards, order/Saga, payment/refunds, Queue Service, Ticket Service, search projection and customer frontend conversion. Event Service does enforce the configured GA section-capacity allocation contract before publication; it does not track live sold/held quantities. These remain owned by later phases.

The current catalog lifecycle records initial occurrence publication state and the lifecycle worker advances scheduled occurrence statuses. Individual occurrence cancellation and published ticket-type pause/resume are implemented. Inventory enforcement remains future work; the Inventory Service must consume occurrence publication and ticket-type status events and enforce current availability and sales policy.

 
## 11. Occurrence lifecycle and cancellation operations

Individual occurrences can be cancelled with `POST /occurrences/:occurrenceId/cancel` (through the Gateway: `POST /api/events/occurrences/:occurrenceId/cancel`). OWNER and ADMIN roles may cancel an occurrence. The operation records `cancelledAt`, an optional reason, increments the occurrence version and inserts `event.occurrence-cancelled` into the outbox in the same transaction. Cancellation is idempotent; a completed occurrence cannot be cancelled.

The lifecycle worker polls published occurrences and advances:
- `SCHEDULED → ON_SALE` when `salesOpenAt` is reached.
- `SCHEDULED/ON_SALE → SALES_CLOSED` when `salesCloseAt` is reached.
- `SCHEDULED/ON_SALE/SALES_CLOSED → COMPLETED` when `endsAt` is reached.

Each transition is row-locked, version-checked and recorded in the transactional outbox as `event.occurrence-sales-opened`, `event.occurrence-sales-closed` or `event.occurrence-completed`. The worker is eventually consistent at its configured polling interval; downstream sales/Inventory enforcement must still check authoritative time windows.

Published ticket types can be paused/resumed through `PATCH /ticket-types/:ticketTypeId/status` (Gateway path: `/api/events/ticket-types/:ticketTypeId/status`). OWNER/ADMIN authorization is required. Only `ACTIVE` and `PAUSED` transitions are supported after publication, and only while the occurrence is `SCHEDULED` or `ON_SALE`. A transition emits `event.ticket-type-status-changed` through the transactional outbox. The event tells future Inventory consumers to stop or resume new holds; it does not release existing holds or cancel completed orders.

## 12. Outbox operational endpoints and alerting

Operational endpoints are internal-only and require mTLS plus a bearer operations token. The metrics route requires a separate metrics token:
- `GET /internal/metrics` — Prometheus text exposition.
- `GET /internal/ops/outbox` — pending, published, dead-letter and oldest-pending summary.
- `GET /internal/ops/outbox/dead-letters` — bounded list of dead-lettered events.
- `POST /internal/ops/outbox/dead-letters/:eventId/retry` — requeue one unpublished dead-lettered event after its root cause is fixed.

Load `monitoring/prometheus/prometheus.yml` and `event-service-alerts.yml` into Prometheus to scrape the protected metrics endpoint using a dedicated client certificate, CA bundle and bearer-token file, and to alert on growing backlog, stale pending events, dead letters and missing metrics. This repository provides the rules file; it does not provision Prometheus or Alertmanager. In production, include the Prometheus scraper certificate CN in `EVENT_SERVICE_MTLS_CLIENT_CNS` and supply the metrics token as a protected secret. The attempts metric is a gauge because requeue deliberately resets per-event attempt counts; it is not a monotonic counter.

## 13. Production service-to-service security

`docker-compose.production.yml` is a deployment overlay, not a complete production environment. Create the external `ticketflow-edge` and `ticketflow-backend` networks. Only an ingress proxy and the API Gateway should join the edge network. The Gateway and trusted backend services join the backend network; Event Service must not have a published host port. Keep PostgreSQL and Kafka reachable only from backend workloads.

Gateway-to-Event-Service traffic uses mutual TLS and a signed, short-lived HMAC assertion. Add the Gateway client certificate CN and any approved Prometheus scraper CN to `EVENT_SERVICE_MTLS_CLIENT_CNS`. Event Service-to-User-Service calls use HTTPS and a separate internal service key. Kafka uses TLS with CA verification and SASL/SCRAM credentials; disable automatic topic creation and provision topics, partitions, retention, replication and least-privilege ACLs before deployment.

Secrets are read from Docker secret files (`*_FILE`). For Gateway assertions, only Event Service (the verifier) needs the previous secret: deploy Event Service with current+previous, switch the Gateway signer to the new current secret, verify traffic, then remove the old previous secret. For User Service internal authentication, only User Service (the receiver) needs the overlap key: deploy User Service with its current key plus `INTERNAL_SERVICE_KEY_PREVIOUS_FILE` set to the next key, switch Event Service to the new `USER_SERVICE_INTERNAL_KEY_FILE`, verify invite lookups, then promote the new key to User Service current and retire the old overlap key after the rollback window. Never mount verifier/receiver overlap keys into callers that do not validate them; never store secret contents in Compose YAML or source control.
