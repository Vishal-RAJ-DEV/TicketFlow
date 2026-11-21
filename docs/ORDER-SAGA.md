# TICKETFLOW — Order Saga and Failure Recovery

**Status:** Phase 1 architecture baseline (proposed target state)  
**Last updated:** 2026-11-21

## 1. Purpose and ownership

Order Service is the Saga orchestrator for a purchase. It coordinates Inventory Service, Payment Service and Ticket Service through authenticated internal commands and committed Kafka facts. Each participant owns its local database and transaction. There is no distributed ACID transaction.

The Saga reaches a valid terminal business outcome despite retries, duplicate messages, crashes and timeouts. A happy-path-only workflow is not complete.

## 2. Order state machine

| State | Meaning |
|---|---|
| CREATED | Idempotent order intent persisted; no inventory yet |
| HOLD_PENDING | Inventory hold command is in progress or must be retried |
| HELD | Inventory confirms temporary reservation |
| PAYMENT_PENDING | Payment attempt created; hold remains bounded by expiry |
| PAYMENT_SUCCEEDED | Verified capture recorded by Order Service |
| INVENTORY_CONFIRM_PENDING | Order is retrying confirmation of inventory hold |
| INVENTORY_CONFIRMED | Inventory Service committed HELD to SOLD |
| TICKETING_PENDING | Ticket issuance request committed; issuance pending |
| COMPLETED | Ticket Service confirms issuance |
| FAILED | Purchase failed before successful capture or terminally rejected |
| EXPIRED | Hold/checkout window expired without successful payment |
| CANCEL_REQUESTED | Cancellation policy and downstream actions are processing |
| REFUND_PENDING | Captured amount requires refund |
| REFUNDED | Provider confirms required refund |
| MANUAL_REVIEW | Automated recovery cannot safely choose an outcome |

Terminal states are not reopened by stale events. A retry is tied to an explicit Saga step and idempotency key.

## 3. Saga step model

Persist a SagaStep for each side effect. Record step, state, attempts, idempotency key, request/response summary, error and timestamps.

| Step | Participant | Idempotency key | Compensation/recovery |
|---|---|---|---|
| RESERVE_INVENTORY | Inventory | orderId + hold:v1 | Release hold |
| CREATE_PAYMENT | Payment | orderId + attempt key | Cancel unused provider order if supported |
| CONFIRM_INVENTORY | Inventory | holdId + confirm:v1 | Later cancellation handled by policy |
| ISSUE_TICKETS | Ticket | orderId + issue:v1 | Revoke tickets |
| RELEASE_INVENTORY | Inventory | orderId + release:v1 | Idempotent cleanup |
| REFUND_PAYMENT | Payment | paymentAttemptId + refund key | Retry/reconcile/manual review |
| REVOKE_TICKETS | Ticket | orderId + revoke:v1 | Do not restore validity automatically |

Step states: PENDING, IN_PROGRESS, SUCCEEDED, RETRYING, COMPENSATING, COMPENSATED, FAILED. Step/order state changes are committed with an Order Service outbox event.

## 4. Happy-path purchase workflow

~~~mermaid
sequenceDiagram
  autonumber
  participant U as Customer
  participant G as API Gateway
  participant Q as Queue Service
  participant O as Order Service
  participant I as Inventory Service
  participant P as Payment Service
  participant R as Razorpay
  participant K as Kafka
  participant T as Ticket Service

  U->>G: POST /orders + Idempotency-Key
  G->>O: Authenticated request
  O->>O: Create or return idempotent order
  O->>Q: Redeem admission token (when required)
  O->>I: Create hold (idempotent orderId)
  I->>I: Atomic DB hold + outbox
  I-->>O: holdId + expiresAt
  O->>P: Create payment attempt (idempotent)
  P-->>O: Checkout details
  O-->>U: 202 order + checkout details
  U->>R: Complete payment
  R->>P: Signed webhook
  P->>P: Verify + deduplicate + outbox
  P->>K: payment.succeeded
  K->>O: payment.succeeded
  O->>O: Validate amount, currency and state
  O->>I: Confirm hold
  I->>I: Atomic HELD -> SOLD
  I-->>O: Confirmed
  O->>O: Commit INVENTORY_CONFIRMED + outbox
  O->>K: order.inventory-confirmed
  K->>T: Issue tickets
  T->>T: Idempotent issuance transaction
  T->>K: ticket.issued
  K->>O: ticket.issued
  O->>O: Mark COMPLETED
~~~

### Detailed sequence

1. **Create order:** Request has authenticated user, occurrence, ticket type/quantity/seat selection, admission token when enabled and Idempotency-Key. Order Service creates or returns the same order for the same user/key. It obtains an authoritative catalog price snapshot; client price is ignored.
2. **Redeem admission token:** When queueing is enabled, Order Service asks Queue Service to redeem a token bound to user and occurrence. Redemption is idempotently bound to orderId. Existing idempotent order is returned before another token is consumed.
3. **Reserve inventory:** Order Service records step intent and sends an idempotent internal command. Inventory Service commits an all-or-nothing hold and returns holdId/expiry. Retrying the same key returns the original hold.
4. **Create payment:** After hold success, Order Service requests a provider payment attempt. Payment Service owns provider order and idempotency. Order becomes PAYMENT_PENDING.
5. **Verify webhook:** Payment Service verifies exact raw-body signature, provider event uniqueness, gateway order, amount and currency. It commits PaymentAttempt state, webhook receipt and payment.succeeded outbox row together.
6. **Resume Saga:** Order Service consumes payment.succeeded via Inbox. It verifies orderId, attempt ID, expected amount/currency and allowed state. Duplicate or stale event cannot progress an invalid order.
7. **Confirm inventory:** Order Service calls Inventory Service. Inventory performs final database-time expiry check and atomically changes assigned seats HELD to SOLD or GA quantity from held to sold. A successful response is the evidence inventory is confirmed.
8. **Request ticket issuance:** Order Service commits INVENTORY_CONFIRMED and order.inventory-confirmed in its outbox.
9. **Issue tickets:** Ticket Service consumes event, validates it and idempotently creates one issuance batch and ticket credentials. It emits ticket.issued from its outbox.
10. **Complete:** Order Service consumes ticket.issued, validates order/issuance IDs and ticket count, then marks COMPLETED. Notification delivery is retryable and does not roll back a valid sale.

Create-order may return HTTP 202 with order state and checkout details. Frontend polls/subscribes to order status. Do not hold an HTTP request open for the entire Saga.

## 5. Inventory hold semantics

- Hold duration is configurable. An initial development default of 8 minutes is reasonable, not a universal business guarantee.
- expiresAt is based on Inventory database clock. Browser time is not authoritative.
- Customer UI displays server-provided countdown.
- Payment window is bounded. If it expires, hold can be released; a late capture is refunded rather than resurrecting inventory.
- Extension is an explicit authenticated internal command with idempotency and a hard maximum. No unbounded extension.
- Confirmation and expiration compete for same hold/seat/shard rows. Row locking/conditional transitions ensure only one wins.
- Expiration worker processes batches using row-level locking such as FOR UPDATE SKIP LOCKED and changes hold plus all allocations in one local transaction.

## 6. Failure and compensation matrix

| Failure point | Required action |
|---|---|
| Admission token invalid/expired | Reject before inventory reservation |
| Requested seat unavailable | Roll back entire hold; customer selects again |
| Inventory times out after committing | Retry same key or query by orderId; never create second hold |
| Payment order creation fails | Release active hold; fail or apply explicit retry policy |
| Payment fails before capture | Release hold; mark failed/expired |
| Payment webhook duplicates | Inbox/provider receipt deduplication |
| Kafka down after Payment DB commit | Outbox publishes after recovery |
| Order Service crashes after hold | Retry same hold command and receive original hold |
| Payment succeeds, Inventory temporarily down | Keep INVENTORY_CONFIRM_PENDING; retry boundedly; no ticket issuance |
| Hold expired before confirmation | Do not confirm; request idempotent refund |
| Ticket Service down after inventory sale | Keep TICKETING_PENDING; retry event; prevent duplicate issuance |
| Ticket issuance permanently fails | Retry/reconcile, then MANUAL_REVIEW and approved compensation |
| Refund provider fails | Keep REFUND_PENDING; retry/reconcile; alert/manual review |
| Stale payment.failed follows payment.succeeded | Reject stale transition; reconcile provider |
| Event cancelled | Stop new sales; resolve holds/orders/refunds/tickets under policy |

## 7. Payment-success versus hold-expiry race

This race must be implemented and tested.

Example:
- Inventory hold expires at 10:08:00 according to Inventory DB time.
- Provider captures at 10:07:59.
- Webhook reaches Payment Service at 10:08:03.
- Expiration worker may already have released the seat.

The system does not retroactively reclaim a seat after another customer may have acquired it. Inventory confirmation checks persisted hold state and expiry. If expiry won, confirmation returns stable HOLD_EXPIRED. Order Service enters REFUND_PENDING and asks Payment Service to refund with an idempotency key.

This design chooses financial compensation over overselling. A later iteration may add a longer bounded payment lease or authorize-then-capture flow if provider and business policy support it. Exact ordering is decided by Inventory's DB transaction, not browser time, Kafka delivery order or Redis TTL.

## 8. Recovery worker

Order Service scans non-terminal orders and incomplete Saga steps using indexed status/updatedAt. It must not blindly rerun every step.

For each candidate:
1. Acquire a lease/claim or optimistic version guard.
2. Read latest order and step state.
3. Determine whether previous side effect may have succeeded.
4. Query participant by stable reference if outcome is unknown.
5. Retry with original idempotency key.
6. Persist result and next outbox event.
7. Escalate after bounded attempts/time to MANUAL_REVIEW.

Watch states include HOLD_PENDING, HELD, PAYMENT_PENDING, PAYMENT_SUCCEEDED, INVENTORY_CONFIRM_PENDING, TICKETING_PENDING, CANCEL_REQUESTED and REFUND_PENDING. Each has a distinct timeout and recovery rule.

Inventory Service independently owns hold TTL. Order Service never directly frees inventory in another database.

## 9. Cancellation workflow

1. Order Service validates ownership, occurrence status and purchase-time cancellation policy.
2. Transition to CANCEL_REQUESTED with compare-and-swap.
3. Ticket Service revokes issued credentials; gate scans reject them after revoke commits.
4. Payment Service initiates refund where required.
5. Inventory Service releases/adjusts sold allocation only when policy and state permit.
6. Order Service marks CANCELLED/REFUNDED after required confirmations. Failed refunds remain REFUND_PENDING and alert operations.

Ticket revocation and refund are not one transaction. A ticket remains void if provider refund is temporarily unavailable.

## 10. Event cancellation

Event Service commits occurrence cancellation and publishes catalog.occurrence-cancelled. Inventory closes occurrence to new holds. Order Service discovers non-terminal and confirmed orders and applies policy. Ticket Service revokes issued credentials. Payment Service processes refunds. Search marks/removes the occurrence. Every service applies event idempotently.

## 11. Compare-and-swap

Use a version field on Order and update conditionally:

~~~sql
UPDATE orders
SET status = 'INVENTORY_CONFIRM_PENDING',
    version = version + 1,
    "updatedAt" = NOW()
WHERE id = :order_id
  AND version = :expected_version
  AND status = 'PAYMENT_SUCCEEDED';
~~~

If zero rows change, another worker/event changed the order. Reload and evaluate current state. Enforce idempotency in DB, not process memory. Inbox unique key is inserted in the same transaction as the local transition.

## 12. Payment event rules

- payment.succeeded references an existing order and PaymentAttempt.
- Amount/currency equal expected amount/currency for that attempt.
- Provider payment ID and webhook event ID are unique in Payment Service.
- Publish success only after provider verification and local commit.
- If order is cancelled/refunded/expired or inventory cannot confirm, do not issue tickets; refund.
- Multiple captures are detected; excess captures reconciled/refunded.
- payment.failed cannot downgrade an order that accepted valid payment.succeeded.

## 13. Ticket issuance and idempotency

Ticket Service consumes order.inventory-confirmed, not payment.succeeded. It inserts TicketIssuance with unique orderId and sourceEventId. Duplicate event returns existing issuance. Ticket rows, credential hashes and ticket.issued outbox commit atomically.

Order becomes COMPLETED only after expected ticket count is confirmed. Email failure does not make the order unpaid or unconfirmed.

## 14. Required failure tests

- Two Order Service instances handle same Idempotency-Key concurrently.
- Inventory hold commits but response times out.
- Payment webhook delivered multiple times and out of order.
- Payment success races hold expiry.
- Inventory DB unavailable during confirmation.
- Order Service exits between every Saga step.
- Kafka unavailable after local DB commit.
- Ticket Service receives order.inventory-confirmed twice.
- Ticket Service commits issuance but crashes before Kafka offset commit.
- Refund provider times out after accepting refund.
- Cancellation races with gate scan.

Assert business invariants and persisted final states, not just HTTP status codes.
