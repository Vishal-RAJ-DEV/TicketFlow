# TICKETFLOW Event Service

**Status:** Phase 2 implementation branch  
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
- Gateway-injected `x-user-id` request context.

Railway-specific station, train, route and schedule models/controllers are not retained in the new Event Service domain.

## 2. Ownership and entity relationships

- `Organizer.ownerId` and `OrganizerMember.userId` are scalar references to User Service IDs. There is no cross-database foreign key.
- `Organizer` owns its venues and events.
- `Venue` owns sections and a sequence of layout versions.
- `VenueSection` is either `ASSIGNED` or `GENERAL_ADMISSION`.
- `VenueSeat` belongs to an assigned section.
- `VenueLayoutVersion` stores an immutable JSON snapshot of active sections and seats at publication time.
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

A layout cannot be published when it contains no active sections, an assigned section has no active seats, or a general-admission section has individual seats.

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
- `GENERAL_ADMISSION` requires a positive capacity.
- `ASSIGNED` does not store an independent capacity; its eligible sections must contain seats.
- Eligible section IDs must exist in the occurrence's published layout snapshot and match the ticket type mode.
- `minPerOrder` and `maxPerOrder` must be positive and max cannot be lower than min.
- Ticket-type sales windows must be contained within the occurrence sales window.
- Ticket types become immutable after occurrence publication. Configure them before publishing the occurrence.

Event Service is authoritative for configured prices and sales rules. Inventory Service will materialize this configuration and own current availability, holds and sold quantities in a later phase.

## 6. Organizer authorization

The API Gateway validates the access token and forwards the verified `x-user-id` header. Event Service then checks ownership/membership against its own Organizer tables.

| Role | Read | Edit catalog | Manage members / cancel event |
|---|---:|---:|---:|
| OWNER | Yes | Yes | Yes |
| ADMIN | Yes | Yes | Yes |
| EDITOR | Yes | Yes | No |
| VIEWER | Yes | No | No |

Creating an organizer sets the authenticated user as its owner. The User Service remains the source of identity; organizer membership is owned here.

The Event Service currently trusts identity headers supplied by the gateway, matching the existing repository pattern. Keep the service on a private application network in deployed environments; do not expose port 4003 publicly or allow untrusted clients to set `x-user-id`.

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
| PATCH | `/ticket-types/:ticketTypeId/status` | Change draft ticket type status |
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

Each event uses the shared envelope with `eventId`, `eventType`, `eventVersion`, `occurredAt`, `producer`, `aggregate` and `data`.

The source database update and outbox insert commit in one Prisma transaction. A worker claims due outbox records using PostgreSQL `FOR UPDATE SKIP LOCKED`, sends to Kafka, then marks the record published. On failure it records the error, releases the claim and schedules bounded exponential retry.

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

Not implemented here: inventory materialization/availability, seat locking/holds, GA allocation, order/Saga, payment/refunds, Queue Service, Ticket Service, search projection and customer frontend conversion. These remain owned by later phases.

The current catalog lifecycle records initial occurrence publication state. Automated scheduled status transitions and inventory enforcement remain future operational work; consumers must rely on the explicit timestamps and the authoritative Inventory Service once it is implemented.
