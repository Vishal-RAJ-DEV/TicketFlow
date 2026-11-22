# TICKETFLOW — Database Design and Data Ownership

**Status:** Phase 2 — Event Service schema implemented; remaining service schemas are design references  
**Last updated:** 2026-11-22  
**Important:** The Event Service's applied schema and migration are maintained in `event-service/prisma/schema.prisma` and `event-service/prisma/migrations/`. Inventory, Order, Payment, Ticket and Notification schemas below remain design references until their implementation phases.

## 1. Persistence strategy

TICKETFLOW uses database-per-service ownership. Local development may use one PostgreSQL server from Docker Compose with separate logical databases and credentials. Production may deploy each database independently.

| Service | Database/store | Owns |
|---|---|---|
| User | user_db (PostgreSQL) | Users, auth providers, session/refresh-token state |
| Event | event_db (PostgreSQL) | Organizers, memberships, events, venues, sections, seats, occurrences, ticket configuration |
| Inventory | inventory_db (PostgreSQL) | Occurrence snapshots, seats, GA shards, holds and allocations |
| Order | order_db (PostgreSQL) | Orders, line items, purchase snapshots, Saga, idempotency, inbox/outbox |
| Payment | payment_db (PostgreSQL) | Payment attempts, webhook receipts, refunds, audit, inbox/outbox |
| Ticket | ticket_db (PostgreSQL) | Issuance batches, tickets, credential hashes, scans and inbox/outbox |
| Notification | notification_db (PostgreSQL) | Delivery attempts, deduplication, retry and provider metadata |
| Search | Elasticsearch | Rebuildable event/availability projections |
| Queue | Redis | Waiting-room sorted sets, admission-token state, active leases |
| API Gateway | Redis | Distributed rate-limit counters and ephemeral gateway state |

Do not share Prisma clients or database credentials between services. Cross-service IDs are scalar references without cross-database relations.

## 2. Source-of-truth rules

- Event Service owns configured price and ticket eligibility. Inventory stores a versioned operational snapshot.
- Inventory owns current seat/GA allocation, hold expiry and confirmation.
- Order owns purchase snapshot and Saga.
- Payment owns provider financial state after verified webhooks/reconciliation.
- Ticket owns credential state and check-in.
- Search is a rebuildable projection.
- Queue is admission state, not proof of sale.
- Do not update another service's DB to repair a workflow. Use authenticated commands/events and reconciliation.

## 3. Common database conventions

- UUID primary keys unless provider IDs are stored as separate unique fields.
- UTC instants; preserve venue timezone separately for display.
- Never use Float/Double for money. Use Prisma Decimal / PostgreSQL NUMERIC and explicit currency. Serialize money as decimal strings.
- Explicit enums for state machines; validate transitions in service code.
- createdAt/updatedAt on mutable aggregates.
- version for compare-and-swap.
- Unique constraints for idempotency, provider IDs, occurrence-seat identity and ticket credentials.
- Add SQL CHECK constraints through migrations for quantity, capacity and non-negative financial invariants where needed.
- Use explicit status/soft deletion for records referenced by financial or ticket audit. Do not cascade-delete paid orders, payments, tickets or scan history.

## 4. Event Service schema (event_service_database)

**Implemented in Phase 2.** The current Prisma schema and migration are the source of truth:

- \`event-service/prisma/schema.prisma\`
- \`event-service/prisma/migrations/20261121140000_event_service_init/migration.sql\`

The implementation includes Organizer, OrganizerMember, Venue, VenueLayoutVersion, VenueSection, VenueSeat, Event, EventOccurrence, TicketType, TicketTypeSection, OutboxEvent and GatewayRequestNonce.

Implementation decisions that differ from the original conceptual sketch:

- Prices are stored as PostgreSQL \`BIGINT\` integer minor units (\`priceMinorUnits\`), not floating-point or decimal currency. API output serializes the value as an integer string.
- Venue layout versions store an immutable JSON snapshot of active sections, seats and GA section capacities at publication time. Occurrences reference the published version they were configured against.
- Each GA `VenueSection` stores a positive physical `capacity`; each GA `TicketTypeSection` stores the capacity allocated by that ticket type in that section. A GA ticket type's total capacity equals the sum of its section allocations. PostgreSQL triggers serialize allocations by occurrence and reject aggregate section over-allocation, including reactivation of archived ticket types.
- `EventOccurrence` retains Prisma's single-column layout-version relation, while a PostgreSQL trigger rejects any occurrence whose selected layout version belongs to a different venue. Ticket-type section ownership and snapshot mode/capacity are enforced in database triggers in addition to service validation.
- Existing GA sections with no recorded section capacity are intentionally not assigned an invented physical capacity during migration. Configure a new layout version with real section capacities before publishing new occurrences against it.
- Occurrence and ticket sales times use timezone-aware PostgreSQL timestamps. API inputs require ISO-8601 date-times with an explicit timezone offset.
- User and organizer-member IDs are scalar references to User Service identity records; there are no cross-database foreign keys.
- Gateway request nonces are stored in Event Service PostgreSQL with a unique primary key, so an assertion can be accepted once across replicas. Expired nonce rows are pruned after the assertion validity window.
- The Event Service owns configuration and pricing. Inventory Service will materialize this data and own runtime availability in its own database.
- Critical event publication and layout publication write an OutboxEvent in the same local database transaction.

## 5. Inventory Service schema reference (inventory_db)

Inventory materializes Event Service publication data and owns runtime availability.

~~~prisma
enum InventoryMode {
  ASSIGNED
  GENERAL_ADMISSION
}

enum InventorySalesState {
  NOT_OPEN
  OPEN
  CLOSED
  CANCELLED
}

enum SeatInventoryStatus {
  AVAILABLE
  HELD
  SOLD
  BLOCKED
}

enum InventoryHoldStatus {
  ACTIVE
  CONFIRMED
  RELEASED
  EXPIRED
}

model InventoryOccurrence {
  occurrenceId  String             @id
  status        InventorySalesState @default(NOT_OPEN)
  layoutVersion Int
  sourceVersion Int                @default(1)
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt

  seats SeatInventory[]
}

model SeatInventory {
  id            String              @id @default(uuid())
  occurrenceId  String
  venueSeatId   String
  sectionId     String
  rowLabel      String
  seatLabel     String
  status        SeatInventoryStatus @default(AVAILABLE)
  activeHoldId  String?
  soldOrderId   String?
  holdExpiresAt DateTime?
  version       Int                 @default(0)
  createdAt     DateTime            @default(now())
  updatedAt     DateTime            @updatedAt

  occurrence InventoryOccurrence @relation(fields: [occurrenceId], references: [occurrenceId])
  activeHold  InventoryHold?       @relation("ActiveSeatHold", fields: [activeHoldId], references: [id])
  holdHistory InventoryHoldSeat[]

  @@unique([occurrenceId, venueSeatId])
  @@index([occurrenceId, status])
  @@index([activeHoldId])
  @@index([holdExpiresAt, status])
}

model InventoryTicketType {
  ticketTypeId  String        @id
  occurrenceId  String
  mode          InventoryMode
  price         Decimal       @db.Decimal(12, 2)
  currency      String
  maxPerOrder   Int
  status        String
  sourceVersion Int

  sectionAccess TicketTypeSectionAccess[]

  @@index([occurrenceId, status])
}

model TicketTypeSectionAccess {
  ticketTypeId String
  sectionId    String

  ticketType InventoryTicketType @relation(fields: [ticketTypeId], references: [ticketTypeId])

  @@id([ticketTypeId, sectionId])
  @@index([sectionId])
}

model TicketPoolShard {
  id            String   @id @default(uuid())
  occurrenceId  String
  ticketTypeId  String
  shardNumber   Int
  capacity      Int
  heldQuantity  Int      @default(0)
  soldQuantity  Int      @default(0)
  version       Int      @default(0)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  allocations InventoryHoldAllocation[]

  @@unique([occurrenceId, ticketTypeId, shardNumber])
  @@index([occurrenceId, ticketTypeId])
}

model InventoryHold {
  id             String              @id @default(uuid())
  occurrenceId   String
  orderId        String              @unique
  userId         String
  idempotencyKey String              @unique
  status         InventoryHoldStatus @default(ACTIVE)
  expiresAt      DateTime
  confirmedAt    DateTime?
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  seats       InventoryHoldSeat[]
  allocations InventoryHoldAllocation[]
  activeSeats SeatInventory[]     @relation("ActiveSeatHold")

  @@index([status, expiresAt])
  @@index([userId, createdAt])
}

model InventoryHoldSeat {
  id              String  @id @default(uuid())
  holdId          String
  seatInventoryId String
  ticketTypeId    String
  unitPrice       Decimal @db.Decimal(12, 2)
  currency        String

  hold          InventoryHold @relation(fields: [holdId], references: [id])
  seatInventory SeatInventory @relation(fields: [seatInventoryId], references: [id])

  @@unique([holdId, seatInventoryId])
  @@index([seatInventoryId])
}

model InventoryHoldAllocation {
  id           String  @id @default(uuid())
  holdId       String
  ticketTypeId String
  shardId      String
  quantity     Int
  unitPrice    Decimal @db.Decimal(12, 2)
  currency     String

  hold  InventoryHold   @relation(fields: [holdId], references: [id])
  shard TicketPoolShard @relation(fields: [shardId], references: [id])

  @@index([holdId])
  @@index([shardId])
}
~~~

Implementation notes:
- Add the InventoryMode enum in Inventory schema; do not import DB enums across services.
- Add InventoryHold relation from SeatInventory.activeHoldId if desired; it is a local relation only.
- Unique occurrenceId + venueSeatId gives one inventory row per physical seat per occurrence.
- Add SQL checks: capacity >= 0; heldQuantity >= 0; soldQuantity >= 0; heldQuantity + soldQuantity <= capacity; quantity > 0; monetary amounts >= 0.
- Hold seat/allocation history remains after terminal state. SeatInventory activeHoldId/expiry clear when no longer held; soldOrderId remains while SOLD.
- Occurrence publication idempotently creates InventoryTicketType, TicketTypeSectionAccess, SeatInventory and GA shards.
- Multi-seat/multi-shard request is one transaction. If any allocation fails, roll back all items.
- For GA, use conditional updates and/or SELECT FOR UPDATE SKIP LOCKED. Never calculate availability in application memory and blindly increment.

### Assigned-seat transition

Within one Inventory transaction, lock requested seat rows in deterministic order, verify all exist and are AVAILABLE, validate eligible sections, create hold and hold-seat snapshots, update all seats to HELD with same hold ID/expiry, write outbox event and commit. Confirmation checks ACTIVE and expiresAt > database current time, locks the hold and related rows, changes seats HELD to SOLD and marks hold CONFIRMED. Expiration competes for the same rows; only one transition wins.

### GA capacity constraint

Add a migration similar to:

~~~sql
ALTER TABLE ticket_pool_shards
ADD CONSTRAINT ga_shard_capacity_nonnegative
CHECK (
  capacity >= 0
  AND "heldQuantity" >= 0
  AND "soldQuantity" >= 0
  AND "heldQuantity" + "soldQuantity" <= capacity
);
~~~

Reservation increments heldQuantity only if the conditional update preserves the constraint. Confirmation moves held to sold in one transaction. Release/expiry decrements held exactly once.

## 6. Order Service schema reference (order_db)

Order Service owns purchase snapshot and Saga, not inventory availability or provider state.

~~~prisma
enum OrderStatus {
  CREATED
  HOLD_PENDING
  HELD
  PAYMENT_PENDING
  PAYMENT_SUCCEEDED
  INVENTORY_CONFIRM_PENDING
  INVENTORY_CONFIRMED
  TICKETING_PENDING
  COMPLETED
  FAILED
  EXPIRED
  CANCEL_REQUESTED
  REFUND_PENDING
  REFUNDED
  MANUAL_REVIEW
}

enum SagaStepStatus {
  PENDING
  IN_PROGRESS
  SUCCEEDED
  RETRYING
  COMPENSATING
  COMPENSATED
  FAILED
}

model Order {
  id              String      @id @default(uuid())
  userId          String
  occurrenceId    String
  status          OrderStatus @default(CREATED)
  currency        String
  totalAmount     Decimal     @db.Decimal(12, 2)
  inventoryHoldId String?     @unique
  paymentOrderId  String?
  idempotencyKey  String
  expiresAt       DateTime?
  version         Int         @default(0)
  failureReason   String?
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  items     OrderItem[]
  seats     OrderSeat[]
  sagaSteps SagaStep[]

  @@unique([userId, idempotencyKey])
  @@index([userId, createdAt])
  @@index([occurrenceId, status])
  @@index([status, updatedAt])
}

model OrderItem {
  id           String  @id @default(uuid())
  orderId      String
  ticketTypeId String
  mode         String
  quantity     Int
  unitPrice    Decimal @db.Decimal(12, 2)
  subtotal     Decimal @db.Decimal(12, 2)
  currency     String

  order Order @relation(fields: [orderId], references: [id])

  @@index([orderId])
}

model OrderSeat {
  id          String  @id @default(uuid())
  orderId     String
  venueSeatId String
  sectionName String
  rowLabel    String
  seatLabel   String
  unitPrice   Decimal @db.Decimal(12, 2)
  currency    String

  order Order @relation(fields: [orderId], references: [id])

  @@unique([orderId, venueSeatId])
}

model SagaStep {
  id             String         @id @default(uuid())
  orderId        String
  step           String
  status         SagaStepStatus @default(PENDING)
  idempotencyKey String         @unique
  attempts       Int            @default(0)
  request        Json?
  response       Json?
  error          String?
  startedAt      DateTime?
  completedAt    DateTime?
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  order Order @relation(fields: [orderId], references: [id])

  @@unique([orderId, step])
  @@index([status, updatedAt])
}

model IdempotencyRecord {
  id          String   @id @default(uuid())
  userId      String
  key         String
  requestHash String
  orderId     String?
  response    Json?
  createdAt   DateTime @default(now())

  @@unique([userId, key])
}

model InboxEvent {
  id           String   @id @default(uuid())
  consumerName String
  eventId      String
  processedAt  DateTime @default(now())

  @@unique([consumerName, eventId])
}

model OutboxEvent {
  id               String    @id @default(uuid())
  aggregateType    String
  aggregateId      String
  aggregateVersion Int
  eventType        String
  eventVersion     Int       @default(1)
  payload          Json
  publishedAt      DateTime?
  attempts         Int       @default(0)
  nextAttemptAt    DateTime  @default(now())
  createdAt        DateTime  @default(now())

  @@index([publishedAt, nextAttemptAt])
  @@index([aggregateId, aggregateVersion])
}
~~~

Add checks for quantity > 0 and non-negative totals. IdempotencyRecord stores requestHash; reusing a key with different request body returns conflict. Keep price/currency and seat labels as immutable purchase snapshots.

## 7. Payment Service schema reference (payment_db)

Payment Service owns provider interaction and refund state. A payment attempt is distinct from an order. A retry may create another attempt; only one successful capture should satisfy an order, and duplicate captures must be reconciled.

~~~prisma
enum PaymentStatus {
  CREATED
  AUTHORIZED
  CAPTURED
  FAILED
  REFUND_PENDING
  REFUNDED
  PARTIALLY_REFUNDED
}

enum RefundStatus {
  INITIATED
  PROCESSING
  SUCCEEDED
  FAILED
}

model PaymentAttempt {
  id                String        @id @default(uuid())
  orderId           String
  attemptNumber     Int
  amount            Decimal       @db.Decimal(12, 2)
  currency          String
  status            PaymentStatus @default(CREATED)
  idempotencyKey    String        @unique
  provider          String        @default("razorpay")
  providerOrderId   String?       @unique
  providerPaymentId String?       @unique
  failureReason     String?
  capturedAt        DateTime?
  version           Int           @default(0)
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  refunds Refund[]

  @@unique([orderId, attemptNumber])
  @@index([orderId, status])
}

model Refund {
  id               String       @id @default(uuid())
  paymentAttemptId String
  amount           Decimal      @db.Decimal(12, 2)
  currency         String
  reason           String?
  status           RefundStatus @default(INITIATED)
  idempotencyKey   String       @unique
  providerRefundId String?      @unique
  failureReason    String?
  createdAt        DateTime     @default(now())
  updatedAt        DateTime     @updatedAt

  paymentAttempt PaymentAttempt @relation(fields: [paymentAttemptId], references: [id])

  @@index([paymentAttemptId, status])
}

model ProviderWebhookReceipt {
  id              String   @id @default(uuid())
  provider        String
  providerEventId String
  eventType       String
  payloadHash     String
  receivedAt      DateTime @default(now())
  processedAt     DateTime?

  @@unique([provider, providerEventId])
}

model PaymentAuditLog {
  id               String   @id @default(uuid())
  paymentAttemptId String
  action           String
  providerResponse Json?
  metadata         Json?
  createdAt        DateTime @default(now())

  @@index([paymentAttemptId, createdAt])
}
~~~

Add Payment Service InboxEvent and OutboxEvent. Verify signature on exact raw body before trusting webhook. Validate provider order ID, captured amount and currency. Never publish payment.succeeded because browser returns to success URL.

## 8. Ticket Service schema reference (ticket_db)

Ticket Service owns credentials, issuance and check-in.

~~~prisma
enum TicketStatus {
  ISSUED
  CHECKED_IN
  VOIDED
  REFUNDED
}

model TicketIssuance {
  id            String   @id @default(uuid())
  orderId       String   @unique
  occurrenceId  String
  sourceEventId String   @unique
  status        String   @default("COMPLETED")
  ticketCount   Int
  createdAt     DateTime @default(now())

  tickets Ticket[]
}

model Ticket {
  id           String       @id @default(uuid())
  issuanceId   String
  orderId      String
  occurrenceId String
  ticketTypeId String
  venueSeatId  String?
  ticketNumber String       @unique
  status       TicketStatus @default(ISSUED)
  issuedAt     DateTime     @default(now())
  checkedInAt  DateTime?
  voidedAt     DateTime?

  issuance   TicketIssuance   @relation(fields: [issuanceId], references: [id])
  credential TicketCredential?
  scans      TicketScan[]

  @@index([orderId])
  @@index([occurrenceId, status])
  @@index([venueSeatId])
}

model TicketCredential {
  id        String   @id @default(uuid())
  ticketId  String   @unique
  tokenHash String   @unique
  createdAt DateTime @default(now())
  expiresAt DateTime?

  ticket Ticket @relation(fields: [ticketId], references: [id])
}

model TicketScan {
  id             String   @id @default(uuid())
  ticketId       String
  scannerId      String
  gateId         String
  idempotencyKey String
  result         String
  scannedAt      DateTime @default(now())

  ticket Ticket @relation(fields: [ticketId], references: [id])

  @@unique([scannerId, idempotencyKey])
  @@index([ticketId, scannedAt])
}
~~~

Add Ticket Service InboxEvent and OutboxEvent. Add a partial unique SQL index for one active assigned-seat ticket per occurrence where venueSeatId is non-null and status is ISSUED or CHECKED_IN. A full unique index blocks legitimate reissue after a ticket is VOIDED. Inventory remains the primary allocation authority; partial index is defense in depth.

Credential:
- Generate cryptographically random opaque token or securely signed opaque credential.
- Persist token hash where possible.
- QR encodes credential, not customer PII.
- Scan validates ticket/event scope/status then atomically transitions ISSUED to CHECKED_IN.
- Concurrent scans result in exactly one success.

## 9. Notification schema reference (notification_db)

Store delivery attempts so provider timeouts and retries are observable. Suggested tables:
- NotificationDelivery: id, sourceEventId, notificationType, recipient reference/email, templateVersion, status, attemptCount, nextAttemptAt, providerMessageId, lastError, createdAt, updatedAt.
- InboxEvent: unique consumerName + eventId.
- OutboxEvent only if Notification Service publishes its own business events.

Do not store unnecessary full ticket credentials. Generate short-lived ticket delivery links through Ticket Service.

## 10. Search and Queue persistence

### Search
Elasticsearch documents are projections only. They can be deleted/rebuilt from catalog events and inventory availability projections. Never use an Elasticsearch result as final authority for a hold.

### Queue
Redis sorted sets provide queue ordering; hashes/sets store user-occurrence membership, admitted sessions and token JTI redemption. Use atomic Redis scripts for join/admit/redeem and persistence/replication appropriate to the environment. If Redis loses queue state during an active sale, pause admission and execute explicit recovery; do not quietly create a new queue pretending to preserve original FIFO position.

## 11. Standard Outbox and Inbox

Every critical event producer has an OutboxEvent table written in the same transaction as business state.

~~~prisma
model OutboxEvent {
  id               String    @id @default(uuid())
  aggregateType    String
  aggregateId      String
  aggregateVersion Int
  eventType        String
  eventVersion     Int       @default(1)
  payload          Json
  publishedAt      DateTime?
  attempts         Int       @default(0)
  nextAttemptAt    DateTime  @default(now())
  lastError        String?
  createdAt        DateTime  @default(now())

  @@index([publishedAt, nextAttemptAt])
  @@index([aggregateId, aggregateVersion])
}

model InboxEvent {
  id           String   @id @default(uuid())
  consumerName String
  eventId      String
  processedAt  DateTime @default(now())

  @@unique([consumerName, eventId])
}
~~~

Do not conflate:
- API idempotency: duplicate client command/request.
- Inbox: duplicate event delivery.
- Outbox: committed event waiting to publish.

They protect different boundaries.

## 12. Important indexes and SQL constraints

Implement and validate these in migrations:

~~~sql
-- One physical seat per occurrence.
CREATE UNIQUE INDEX inventory_occurrence_seat_unique
ON seat_inventories ("occurrenceId", "venueSeatId");

-- Seat-map and hold lookups.
CREATE INDEX inventory_occurrence_status_idx
ON seat_inventories ("occurrenceId", status);

CREATE INDEX inventory_hold_expiry_idx
ON inventory_holds (status, "expiresAt");

-- A GA shard cannot oversell.
ALTER TABLE ticket_pool_shards
ADD CONSTRAINT ga_shard_capacity_check
CHECK (
  capacity >= 0
  AND "heldQuantity" >= 0
  AND "soldQuantity" >= 0
  AND "heldQuantity" + "soldQuantity" <= capacity
);

-- One active ticket per assigned seat; VOIDED/REFUNDED history may remain.
CREATE UNIQUE INDEX ticket_active_occurrence_seat_unique
ON tickets ("occurrenceId", "venueSeatId")
WHERE "venueSeatId" IS NOT NULL
  AND status IN ('ISSUED', 'CHECKED_IN');
~~~

Also add CHECK quantity > 0, non-negative monetary amounts, unique userId + idempotencyKey for orders, unique orderId + idempotencyKey for holds, unique provider + providerEventId, unique provider payment/refund IDs, unique issuance orderId/sourceEventId, unique credential hash and unique consumerName + eventId for Inbox.

Review query plans against realistic row counts. Indexes increase write cost, particularly for hot inventory tables.

## 13. Concurrency transaction requirements

### Assigned seat hold
1. Lock requested seat rows in deterministic venueSeatId order.
2. Verify all rows exist and are AVAILABLE.
3. Verify ticket type permits sections and sales are open.
4. Create InventoryHold and InventoryHoldSeat snapshot rows.
5. Update every seat to HELD with same hold ID/expiry.
6. Insert inventory.hold-created into outbox.
7. Commit.

If any validation/update fails, roll back all.

### GA allocation
1. Validate occurrence and ticket type.
2. Select candidate shards with enough remaining capacity using row locks/conditional updates.
3. Increment held quantity in one or more shards.
4. Create InventoryHold and allocation rows.
5. Insert outbox event.
6. Commit only if full requested quantity is allocated; otherwise roll back.

### Confirm
Lock hold and related seat/shard rows. Check ACTIVE and expiresAt > database current time. Move held inventory to sold and mark hold CONFIRMED in one transaction. Repeated confirm returns original confirmed result; expired/released hold returns stable conflict.

### Expire/release
Lock eligible active holds in batches. Change only rows still owned by target hold. Decrement GA held counters only for allocations not already transitioned. Mark terminal hold state and write outbox in same transaction.

## 14. Retention, backup and reconciliation

- Payment, refund, order, issuance and scan records are audit-sensitive; never cascade-delete with catalog records.
- Define retention separately for logs, outbox/inbox, queue state and customer data.
- Archive cold orders/scans only after legal, support and analytics requirements are defined.
- Back up each service DB independently and test restores.
- Rebuild Elasticsearch from catalog events/source APIs.
- Queue Redis is operational state; configure persistence/failover and document active-sale recovery.
- Reconcile captured payments without completed orders, confirmed inventory without issuance, expired holds still HELD, GA counter drift, duplicate captures and refund discrepancies.

## 15. Implementation caveats

These schemas define the target, not drop-in migrations. Before implementation:
1. Confirm exact Prisma version and generator/datasource syntax used in each service.
2. Add missing relations, enum definitions, indexes and mapping conventions.
3. Write SQL migrations for CHECK and partial unique constraints.
4. Validate delete/update behaviour and transaction isolation.
5. Add integration tests for every invariant.
6. Never point a service at another service's database to simplify a query.
