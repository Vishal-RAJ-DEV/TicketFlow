# TICKETFLOW — Kafka Event Contracts

**Status:** Phase 1 architecture baseline (proposed contracts)  
**Last updated:** 2026-11-21

## 1. Contract rules

Kafka carries committed facts and asynchronous notifications between service boundaries. It does not replace internal APIs for commands that require an immediate result.

Examples:
- Order Service calls Inventory Service to create/confirm/release a hold and needs the outcome.
- Payment Service receives a provider webhook, commits its local payment transition and publishes payment.succeeded.
- Search Service consumes catalog and inventory facts to update a read projection.
- Ticket Service consumes order.inventory-confirmed to issue credentials.

Rules:
1. Topic names are lowercase and dot-separated; the producer domain owns the topic.
2. Every event has globally unique eventId, explicit eventType and eventVersion.
3. Events are immutable facts; correction is a new event.
4. Payloads contain stable IDs and minimum consumer data. Do not publish secrets or unnecessary PII.
5. Schema changes must be compatible; do not silently change a field's type or meaning.
6. Consumers tolerate duplicate delivery.
7. Message keys are selected per aggregate; not every event is keyed by occurrence.
8. Commit consumer offsets only after local DB transaction commits.
9. Critical producers use Transactional Outbox; critical consumers use Inbox.
10. Do not claim global exactly-once semantics across databases and external providers.

## 2. Standard event envelope

All business events use this envelope:

~~~json
{
  "eventId": "uuid",
  "eventType": "payment.succeeded",
  "eventVersion": 1,
  "occurredAt": "2026-11-21T10:30:00.000Z",
  "producer": "payment-service",
  "aggregateType": "PaymentAttempt",
  "aggregateId": "payment_attempt_123",
  "aggregateVersion": 2,
  "correlationId": "order_123",
  "causationId": "event_that_triggered_this",
  "data": {
    "paymentAttemptId": "payment_attempt_123",
    "orderId": "order_123",
    "amount": "2999.00",
    "currency": "INR",
    "status": "CAPTURED"
  }
}
~~~

| Field | Meaning |
|---|---|
| eventId | Stable unique ID generated once and persisted in outbox |
| eventType | Qualified name, e.g. payment.succeeded |
| eventVersion | Version of payload contract |
| occurredAt | UTC time the business fact was committed/recorded |
| producer | Owning service |
| aggregateType / aggregateId | Entity whose state changed |
| aggregateVersion | Monotonic aggregate version where applicable |
| correlationId | End-to-end workflow correlation, normally orderId |
| causationId | Event/command that caused this transition where known |
| data | Event-specific payload |

Retries keep the same eventId. Kafka may deliver the same message more than once; Inbox deduplication uses this stable ID.

## 3. Topic catalogue

This is the proposed first contract set. Partition count, replication factor and retention are deployment decisions to load-test. Local single-broker Kafka is development-only; production requires a suitably replicated cluster.

| Topic | Producer | Main consumers | Suggested key | Purpose |
|---|---|---|---|---|
| catalog.event-published | Event | Search | eventId | Event becomes discoverable |
| catalog.event-updated | Event | Search | eventId | Search metadata changes |
| catalog.occurrence-published | Event | Inventory, Search, Queue | occurrenceId | Materialize occurrence/open discovery |
| catalog.occurrence-updated | Event | Inventory, Search | occurrenceId | Versioned schedule/config update |
| catalog.occurrence-cancelled | Event | Inventory, Order, Ticket, Search, Notification | occurrenceId | Stop sales/coordinated cancellation |
| inventory.hold-created | Inventory | Order, Analytics | orderId | Hold committed |
| inventory.hold-confirmed | Inventory | Order, Analytics | orderId | Hold became sale |
| inventory.hold-released | Inventory | Order, Analytics | orderId | Active hold released |
| inventory.hold-expired | Inventory | Order, Analytics | orderId | Expiration won |
| inventory.availability-changed | Inventory | Search | occurrenceId + ticketTypeId | Availability projection changed |
| order.created | Order | Analytics, optional Notification | orderId | Purchase intent persisted |
| order.inventory-confirmed | Order | Ticket | orderId | Inventory confirmed; tickets may issue |
| order.failed | Order | Notification, Analytics | orderId | Order failed |
| order.completed | Order | Notification, Analytics | orderId | Ticket issuance completed |
| order.cancelled | Order | Ticket, Notification, Analytics | orderId | Cancellation completed |
| payment.succeeded | Payment | Order, Analytics | orderId | Provider capture verified |
| payment.failed | Payment | Order, Analytics | orderId | Payment attempt failed |
| payment.refund-succeeded | Payment | Order, Notification | orderId | Provider confirms refund |
| payment.refund-failed | Payment | Order, Operations | orderId | Refund needs retry/review |
| ticket.issued | Ticket | Order, Notification, Analytics | orderId | Issuance batch committed |
| ticket.revoked | Ticket | Notification, Analytics | orderId | Ticket(s) invalidated |
| ticket.checked-in | Ticket | Analytics | ticketId | Gate entry recorded |

Queue-position changes should not be published individually to Kafka; this creates unnecessary volume. Emit coarse metrics or milestone events only.

## 4. Event-specific data contracts

The following are event-specific data bodies; each is wrapped in the standard envelope.

### catalog.occurrence-published

~~~json
{
  "occurrenceId": "occ_123",
  "eventId": "event_123",
  "venueId": "venue_123",
  "startsAt": "2026-12-15T12:30:00.000Z",
  "endsAt": "2026-12-15T16:30:00.000Z",
  "venueTimezone": "Asia/Kolkata",
  "layoutVersion": 4,
  "salesOpenAt": "2026-11-25T04:30:00.000Z",
  "salesCloseAt": "2026-12-15T11:30:00.000Z",
  "sections": [
    {
      "sectionId": "section_a",
      "name": "Lower Bowl",
      "mode": "ASSIGNED",
      "seats": [
        { "venueSeatId": "seat_a_10", "rowLabel": "A", "seatLabel": "10" }
      ]
    }
  ],
  "ticketTypes": [
    {
      "ticketTypeId": "vip_123",
      "code": "VIP",
      "name": "VIP",
      "mode": "ASSIGNED",
      "price": "2999.00",
      "currency": "INR",
      "maxPerOrder": 6,
      "salesStartsAt": "2026-11-25T04:30:00.000Z",
      "salesEndsAt": "2026-12-15T11:30:00.000Z",
      "allowedSectionIds": ["section_a"]
    }
  ]
}
~~~

Inventory Service stores source aggregate version and layoutVersion. Duplicate event IDs are ignored. Older versions must not overwrite newer configuration. After sales start, layout changes require explicit migration policy; the consumer must not silently delete sold/held seats.

### inventory.hold-created

~~~json
{
  "holdId": "hold_123",
  "orderId": "order_123",
  "occurrenceId": "occ_123",
  "userId": "user_123",
  "expiresAt": "2026-11-21T10:38:00.000Z",
  "items": [
    {
      "kind": "ASSIGNED_SEAT",
      "ticketTypeId": "vip_123",
      "venueSeatId": "seat_a_10",
      "quantity": 1,
      "unitPrice": "2999.00",
      "currency": "INR"
    }
  ]
}
~~~

### payment.succeeded

~~~json
{
  "paymentAttemptId": "payment_attempt_123",
  "orderId": "order_123",
  "provider": "razorpay",
  "providerOrderId": "provider_order_123",
  "providerPaymentId": "provider_payment_123",
  "amount": "5998.00",
  "currency": "INR",
  "capturedAt": "2026-11-21T10:34:22.000Z"
}
~~~

Emit only after Payment Service verifies provider notification/signature and commits payment state plus outbox row. Order Service independently validates order, amount, currency and legal state.

### order.inventory-confirmed

~~~json
{
  "orderId": "order_123",
  "occurrenceId": "occ_123",
  "inventoryHoldId": "hold_123",
  "confirmedAt": "2026-11-21T10:34:24.000Z",
  "items": [
    {
      "ticketTypeId": "vip_123",
      "quantity": 2,
      "seatIds": ["seat_a_10", "seat_a_11"]
    }
  ]
}
~~~

This is the issuance authorization boundary for Ticket Service. It must not issue from order.created or payment.succeeded alone.

### ticket.issued

~~~json
{
  "issuanceId": "issuance_123",
  "orderId": "order_123",
  "occurrenceId": "occ_123",
  "ticketCount": 2,
  "ticketIds": ["ticket_1", "ticket_2"],
  "issuedAt": "2026-11-21T10:34:26.000Z"
}
~~~

Do not include raw QR secrets, signed credentials or customer PII. Notification Service can fetch delivery data from an authenticated Ticket Service API or protected delivery mechanism.

## 5. Partitioning and ordering

- Catalog: eventId or occurrenceId according to changed aggregate.
- Seat-level inventory facts: occurrenceId + venueSeatId.
- GA shard facts: occurrenceId + ticketTypeId + shardId.
- Order and payment: orderId.
- Ticket lifecycle: ticketId; issuance batch events: orderId.

Kafka preserves ordering only within a partition. Different keys process concurrently. Consumers validate aggregateVersion and state rather than assuming global ordering.

Select partition count from expected consumer parallelism and load tests. Production config includes replication factor, min.insync.replicas, producer acknowledgements, retention, quotas and consumer-lag alerts. A local single broker cannot demonstrate production broker fault tolerance.

## 6. Transactional Outbox publisher

For a service-owned transition:
1. Begin local DB transaction.
2. Validate current state/version.
3. Apply business update.
4. Insert OutboxEvent with stable eventId, aggregateVersion, eventType and payload.
5. Commit.
6. Publisher claims unpublished rows in batches, sends to Kafka and marks publishedAt only after broker acknowledgement.

Publisher requirements:
- Concurrent instances must not claim the same rows unsafely; use row locking such as FOR UPDATE SKIP LOCKED or a lease/claim column.
- Retry transient failures with bounded exponential backoff and jitter.
- Preserve eventId on retry.
- Monitor oldest unpublished age and attempts.
- Retain/archive event history according to an audit policy.

## 7. Consumer Inbox and offset policy

1. Parse and validate envelope.
2. Begin local DB transaction.
3. Insert (consumerName, eventId) into InboxEvent.
4. If unique key already exists, commit without repeating business effect.
5. Apply local state transition and write resulting outbox events in the same transaction.
6. Commit DB transaction.
7. Commit Kafka offset.

If processing fails before commit, transaction rolls back and Kafka can redeliver. If DB commits but the process crashes before offset commit, redelivery is handled by Inbox.

For consumers without relational storage (e.g. initial Queue Service), use an atomic Redis deduplication/state update with bounded retention, or add durable storage if an operation must survive Redis loss. Redis SET alone is not a durable cross-system transaction.

## 8. Retry and dead-letter policy

Classify errors:
- **Transient:** timeout, temporary network/database outage. Retry with bounded backoff.
- **Concurrency/state conflict:** reload authoritative state; do not blindly retry an invalid transition.
- **Permanent contract/data error:** malformed schema or missing required data. Send to DLQ after validation and alert.
- **Provider uncertainty:** reconcile with provider before retrying a chargeable operation.

DLQ record preserves original topic, partition, offset, key, headers, eventId, payload, consumer group, first failure time, latest error and retry count. Replay is controlled/audited and preserves eventId so Inbox protects against duplicate effects.

## 9. Schema governance and security

- Store event schemas alongside code under shared/contracts or introduce a schema registry later.
- Validate producers and consumers in CI.
- Add optional fields compatibly; use a new eventVersion/eventType for breaking semantic changes.
- Consumers ignore unknown optional fields.
- Never reuse a field for a different meaning.
- Shared topic-name constants prevent spelling mistakes but do not validate payload compatibility.
- Kafka uses private networks, authenticated least-privilege producer/consumer identities in production.
- Do not publish access tokens, payment secrets, raw QR credentials or unnecessary personal data.
- Mask sensitive payloads in logs and DLQ tools.
- Treat consumed events as untrusted input; producer field is not authentication.

## 10. Operational metrics

Monitor publish failures, outbox age, retry count, consumer lag, processing latency, duplicate count, DLQ ingress, schema validation failures and per-topic throughput. Alert when a critical business event is not progressing within workflow timeout.
