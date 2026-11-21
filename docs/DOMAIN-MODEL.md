# TICKETFLOW — Domain Model and Business Rules

**Status:** Phase 2 — Event Service domain entities implemented; Inventory/Order/Payment/Ticket/Queue remain target model  
**Last updated:** 2026-11-21

## 1. Purpose

This document defines product vocabulary, business entities, ownership boundaries and invariants. Service implementation and API naming must follow this model. Each domain entity has one owning service; other services store IDs and local snapshots rather than querying another service's database.

## 2. Actors and permissions

| Actor | Meaning | Main permissions |
|---|---|---|
| Customer | Person purchasing tickets | Discover, join queue, create orders, view tickets, request eligible cancellation |
| Organizer owner | Account responsible for an organizer | Manage organizer members, events, venues and sales |
| Organizer manager | Delegated organizer member | Manage resources allowed by assigned role |
| Gate operator | Staff validating entry | Scan tickets only for assigned events/venues |
| Platform operator | Trusted support/operations role | Investigate exceptions, replay DLQ, reconcile payments, audited intervention |

User Service owns authentication identity. Event Service owns organizer membership and roles. The implemented schema is in `event-service/prisma/schema.prisma` and its migration directory. Gate permissions are event/venue-scoped. A customer role in a JWT does not grant organizer or gate access.

## 3. Ubiquitous language

- **Event:** Catalog-level product, such as a tour, league match, festival or conference. It can have many occurrences.
- **Occurrence:** One independently bookable instance at a venue and a specific time. Inventory, queue, order and sale windows are scoped to an occurrence.
- **Venue:** Physical location with timezone and sections.
- **Venue section:** Named area such as Floor, Lower Bowl, VIP or Balcony. A section is assigned seating or general admission.
- **Venue seat:** Stable physical seat definition in the venue layout. It is not a reservation.
- **Ticket type:** Saleable offer for an occurrence, e.g. VIP or General Admission. Defines price, currency, sale window, per-order limits and permitted sections.
- **Inventory seat:** Occurrence-specific operational state for one physical venue seat. Owned by Inventory Service.
- **GA pool shard:** Bounded slice of a general-admission ticket type's capacity.
- **Hold:** Temporary, expiring reservation of seats or GA quantity for one order. A hold is not a sale.
- **Order:** Customer purchase aggregate with price snapshot, line items and distributed workflow state.
- **Payment attempt:** One provider payment attempt associated with an order. Provider capture alone is not proof inventory was confirmed.
- **Ticket:** Credential issued for a confirmed order. Assigned-seat ticket identifies a seat; GA ticket represents one admission unit.
- **Check-in:** One-time gate transition marking an issued ticket as used.
- **Admission token:** Short-lived, single-use permit for a user/session to enter an occurrence's purchase flow.
- **Queue entry:** Customer's waiting-room position. It is not a reservation or ticket.

## 4. Aggregate ownership and logical relationships

~~~mermaid
erDiagram
  ORGANIZER ||--o{ EVENT : owns
  ORGANIZER ||--o{ ORGANIZER_MEMBER : has
  EVENT ||--o{ OCCURRENCE : has
  VENUE ||--o{ VENUE_SECTION : contains
  VENUE_SECTION ||--o{ VENUE_SEAT : defines
  OCCURRENCE ||--o{ TICKET_TYPE : sells
  TICKET_TYPE }o--o{ VENUE_SECTION : permits
  OCCURRENCE ||--o{ INVENTORY_SEAT : materializes
  OCCURRENCE ||--o{ GA_POOL_SHARD : allocates
  ORDER ||--o{ ORDER_ITEM : contains
  ORDER ||--o{ ORDER_SEAT : snapshots
  ORDER ||--o| INVENTORY_HOLD : reserves
  ORDER ||--o{ PAYMENT_ATTEMPT : pays
  ORDER ||--o| TICKET_ISSUANCE : issues
  TICKET_ISSUANCE ||--|{ TICKET : creates
  TICKET ||--o{ TICKET_SCAN : records
~~~

The diagram is logical, not a cross-service foreign-key design. Event Service owns VENUE_SEAT; Inventory Service stores external venueSeatId and a layout snapshot.

| Aggregate/entity | Owner | Notes |
|---|---|---|
| Organizer, OrganizerMember | Event Service | Membership is organizer-scoped |
| Event, Occurrence | Event Service | Occurrence is inventory boundary |
| Venue, Section, Seat layout | Event Service | Versioned and published |
| TicketType, permitted sections | Event Service | Price and sales-rule source |
| InventoryOccurrence, InventorySeat | Inventory Service | Materialized configuration and allocation |
| GA Pool Shard | Inventory Service | Capacity counter/contention boundary |
| InventoryHold and allocations | Inventory Service | Temporary ownership |
| Order, OrderItem, OrderSeat, SagaStep | Order Service | Purchase and orchestration |
| PaymentAttempt, Refund, webhook receipt | Payment Service | Financial provider state |
| TicketIssuance, Ticket, Credential, TicketScan | Ticket Service | Ticket and admission source |
| Search document | Search Service | Rebuildable projection |
| Queue entry/admission token | Queue Service | Short-lived admission state |

No cross-service database foreign keys. An ID belonging to another service is a scalar reference.

## 5. Event and occurrence rules

1. An event may have multiple occurrences; each occurrence has exactly one venue and timezone.
2. Occurrence is the unit of availability, sale windows, queue, inventory, order and check-in.
3. Start/end and sale-window times are stored as UTC instants; venue timezone is retained for display/input.
4. Each occurrence has a versioned venue-layout snapshot. Post-sale layout changes require an explicit migration policy and must never silently remap sold seats.
5. Event publication does not imply every occurrence is already on sale.
6. Sale eligibility requires occurrence state, ticket-type state and ticket-type sales window to permit purchase.
7. Event Service is authoritative for price. Order Service stores the price/currency snapshot used for purchase. Client cannot set price.

## 6. Inventory modes

### Assigned seating
- A physical seat can be offered through a ticket type only when its section is eligible.
- Inventory Service materializes one InventorySeat per occurrence and physical venue seat.
- States: AVAILABLE, HELD, SOLD, BLOCKED.
- HELD requires a hold owner and expiry; SOLD requires a confirmed order reference; AVAILABLE has neither.
- Multi-seat hold is atomic: all requested seats are held or none.
- An assigned seat cannot be allocated to two active holds or two active sales for the same occurrence.

### General admission
- A GA ticket type has finite capacity and no individually selected seat.
- Capacity is split across GA pool shards for write distribution.
- Each shard satisfies heldQuantity >= 0, soldQuantity >= 0 and heldQuantity + soldQuantity <= capacity.
- A request for N units allocates all N or none. Multi-shard allocation commits in one Inventory transaction.
- Sum of shard capacities equals configured GA capacity for the ticket type.

### Hold lifecycle

~~~mermaid
stateDiagram-v2
  [*] --> ACTIVE
  ACTIVE --> CONFIRMED: valid payment and inventory confirmation
  ACTIVE --> RELEASED: cancellation or payment failure
  ACTIVE --> EXPIRED: database-time TTL wins
  CONFIRMED --> [*]
  RELEASED --> [*]
  EXPIRED --> [*]
~~~

A hold has immutable orderId and idempotency key. Expiration uses Inventory database time. EXPIRED or RELEASED cannot transition to CONFIRMED; another purchase requires a new hold.

## 7. Order and payment rules

- Order is created idempotently per customer and client idempotency key.
- Order quantities and prices are validated server-side from an authoritative Event Service snapshot.
- Order total is the sum of line subtotals and separately modelled fees/taxes. Do not silently include unmodelled fees.
- Order preserves ticket type, quantity, currency, unit price and assigned seat labels as purchase-time snapshots.
- Order Service owns purchase state; Payment Service owns provider status. Neither edits the other's database.
- Provider payment success is necessary but not sufficient for order completion.
- Inventory must confirm the hold before Ticket Service can issue tickets.
- A captured payment that cannot be fulfilled is routed to refund compensation or manual review.
- Duplicate webhook deliveries have one business effect. Multiple captures for one order are detected and excess captures reconciled/refunded.

## 8. Order lifecycle

~~~mermaid
stateDiagram-v2
  [*] --> CREATED
  CREATED --> HOLD_PENDING
  HOLD_PENDING --> HELD
  HOLD_PENDING --> FAILED
  HELD --> PAYMENT_PENDING
  PAYMENT_PENDING --> PAYMENT_SUCCEEDED
  PAYMENT_PENDING --> FAILED
  PAYMENT_PENDING --> EXPIRED
  PAYMENT_SUCCEEDED --> INVENTORY_CONFIRM_PENDING
  INVENTORY_CONFIRM_PENDING --> INVENTORY_CONFIRMED
  INVENTORY_CONFIRM_PENDING --> REFUND_PENDING
  INVENTORY_CONFIRMED --> TICKETING_PENDING
  TICKETING_PENDING --> COMPLETED
  TICKETING_PENDING --> MANUAL_REVIEW
  REFUND_PENDING --> REFUNDED
  REFUND_PENDING --> MANUAL_REVIEW
  CREATED --> CANCELLED
  HELD --> CANCELLED
  PAYMENT_PENDING --> CANCEL_REQUESTED
  COMPLETED --> CANCEL_REQUESTED
  CANCEL_REQUESTED --> REFUND_PENDING
  CANCEL_REQUESTED --> CANCELLED
~~~

This is conceptual. ORDER-SAGA.md defines legal transitions, events and compensation. Terminal states must not be reopened by stale events.

## 9. Ticket and gate rules

1. Tickets are generated only from an order whose inventory confirmation succeeded.
2. One order-level issuance request creates one issuance batch; duplicate delivery returns the existing batch.
3. Assigned-seat tickets preserve occurrence, ticket type, section, row and seat labels as snapshots.
4. GA orders issue one credential per admission unit in the first release.
5. Each ticket has a unique opaque credential; QR must not contain PII, email, phone or payment details.
6. Ticket Service owns credential validation and status.
7. Gate access requires event/venue-scoped authorization.
8. Check-in is an atomic ISSUED-to-CHECKED_IN transition. Exactly one concurrent scan succeeds.
9. Duplicate scan is rejected and audited. VOIDED or REFUNDED tickets cannot be checked in.

## 10. Queue rules

- Queue is enabled per occurrence/sale policy, not assumed for every event.
- Queue entry belongs to one user/session and one occurrence.
- Queue order is FIFO under the configured policy; any priority/organizer override must be documented and audited.
- Admission token is bound to user, occurrence, expiry and unique JTI.
- Redemption is single-use and idempotently bound to orderId.
- Queue admission does not reserve inventory or promise availability.
- If Queue Service/Redis is unhealthy while queueing is required, new admission pauses/fails closed.

## 11. Cancellation and event cancellation

- Customer cancellation eligibility is determined from the policy snapshot accepted at purchase time.
- Order Service coordinates cancellation; Ticket Service owns revocation; Payment Service owns refunds; Inventory Service owns release where policy/state permit.
- Gate scans reject revoked tickets after revocation commits in Ticket Service.
- Event cancellation stops new sales and initiates coordinated handling for active holds, confirmed orders, ticket revocation and refunds.
- Refund failure does not restore ticket validity automatically; it creates a recoverable financial exception.
- Every manual override is actor-attributed and audited.

## 12. Invariants to encode in tests and database constraints

| Invariant | Primary enforcement |
|---|---|
| One inventory row per occurrence/physical seat | Unique database constraint |
| No seat double hold/sale | Row lock + conditional transition |
| No GA oversell | SQL check + conditional shard update |
| All-or-none multi-item hold | One local DB transaction |
| No confirmation after expiry | Conditional transition using DB time |
| One logical order per idempotency key | Unique constraint |
| One issuance batch per order | Unique orderId in Ticket Service |
| One credential per ticket | Unique credential hash |
| One successful check-in per ticket | Conditional update/row lock |
| No ticket without confirmed inventory | Order event gate + consumer validation |
| Duplicate event has no duplicate effect | Inbox unique key + local transaction |

## 13. Product decisions to confirm later

Organizer verification; refund cutoff/fees; ticket transfers/resale; tax/platform fees; per-category quantity limits; priority queue rules; gate scanner online/offline expectations; organizer settlement. Do not embed unresolved policy assumptions in inventory correctness logic.
