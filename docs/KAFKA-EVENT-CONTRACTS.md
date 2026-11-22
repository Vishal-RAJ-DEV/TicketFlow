# TICKETFLOW — Kafka Event Contracts

**Status:** Phase 2 — Event Service catalog topics and envelope implemented; downstream topics remain proposed  
**Last updated:** 2026-11-22

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
  "eventType": "event.occurrence-published",
  "eventVersion": 1,
  "occurredAt": "2026-11-21T10:30:00.000Z",
  "producer": "event-service",
  "aggregate": {
    "type": "EVENT_OCCURRENCE",
    "id": "occurrence_123",
    "version": 1
  },
  "data": {
    "occurrence": {
      "id": "occurrence_123",
      "eventId": "event_123",
      "venueId": "venue_123",
      "venueLayoutVersionId": "layout_version_2"
    }
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
| aggregate.type / aggregate.id | Entity whose state changed |
| aggregate.version | Monotonic aggregate version where applicable |
| data | Event-specific payload |

The Phase 2 Event Service envelope currently emits `aggregate: { type, id, version }`. Correlation and causation identifiers should be added by a service when it has a real workflow context; do not emit fabricated values.

Retries keep the same eventId. Kafka may deliver the same message more than once; Inbox deduplication uses this stable ID.

## 3. Topic catalogue

This is the proposed first contract set. Partition count, replication factor and retention are deployment decisions to load-test. Local single-broker Kafka is development-only; production requires a suitably replicated cluster.

| Topic | Producer | Main consumers | Suggested key | Purpose |
|---|---|---|---|---|
| event.published | Event Service | Search | eventId | Event becomes discoverable |
| event.updated | Event Service | Search | eventId | Published event metadata changes |
| event.cancelled | Event Service | Inventory, Order, Ticket, Search, Notification | eventId | Stop sales/coordinated cancellation |
| event.occurrence-published | Event Service | Inventory, Search, Queue | occurrenceId | Materialize published occurrence configuration |
| venue.layout-version-published | Event Service | Inventory | layoutVersionId | Publish immutable venue layout snapshot |
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

### event.published

The payload is the published event catalog record. It includes the event ID, organizer ID, title, slug, descriptive metadata, category, media URLs and publication timestamp. The aggregate key is the event ID.

### event.updated

Published event metadata was changed. Consumers use the aggregate version to reject stale updates and rebuild their event projection from the payload.

### event.cancelled

The organizer cancelled the event. The current Event Service payload includes the event ID, slug, cancellation reason and the IDs of occurrences cancelled in the same local transaction. Downstream consumers must stop new sale activity and run their own order/ticket compensation policies.

### venue.layout-version-published

The payload includes venue metadata and a \`layoutVersion\` object containing its ID, version, publication timestamp and immutable snapshot. The snapshot contains active section IDs/names/modes, GA physical capacities and the seats belonging to assigned sections.

### event.occurrence-published

The Phase 2 Event Service emits this payload when an occurrence transitions from DRAFT to SCHEDULED or ON_SALE. The layout snapshot includes a `capacity` value for each section (null for assigned seating). Each GA ticket type includes `sectionAllocations`, with one positive allocation per eligible section; its `capacity` equals the sum of those values. For an assigned ticket type, each section allocation has a null capacity.

~~~json
{
  "occurrence": {
    "id": "occ_123",
    "eventId": "event_123",
    "venueId": "venue_123",
    "venueLayoutVersionId": "layout_version_2",
    "startsAt": "2026-12-15T12:30:00.000Z",
    "endsAt": "2026-12-15T16:30:00.000Z",
    "salesOpenAt": "2026-11-25T04:30:00.000Z",
    "salesCloseAt": "2026-12-15T11:30:00.000Z",
    "status": "SCHEDULED",
    "version": 1
  },
  "event": {
    "id": "event_123",
    "organizerId": "organizer_123",
    "title": "Live Music Festival",
    "slug": "live-music-festival",
    "category": "MUSIC"
  },
  "venue": {
    "id": "venue_123",
    "name": "City Arena",
    "city": "Delhi",
    "timezone": "Asia/Kolkata"
  },
  "layoutVersion": {
    "id": "layout_version_2",
    "version": 2,
    "snapshot": {
      "schemaVersion": 1,
      "venueId": "venue_123",
      "layoutVersionId": "layout_version_2",
      "version": 2,
      "sections": [
        {
          "id": "section_a",
          "name": "Lower Bowl",
          "mode": "ASSIGNED",
          "capacity": null,
          "seats": [
            { "id": "seat_a_10", "rowLabel": "A", "seatLabel": "10", "x": 10, "y": 20 }
          ]
        }
      ]
    }
  },
  "ticketTypes": [
    {
      "id": "vip_123",
      "occurrenceId": "occ_123",
      "name": "VIP",
      "code": "VIP",
      "mode": "ASSIGNED",
      "priceMinorUnits": "299900",
      "currency": "INR",
      "capacity": null,
      "minPerOrder": 1,
      "maxPerOrder": 6,
      "salesStartsAt": "2026-11-25T04:30:00.000Z",
      "salesEndsAt": "2026-12-15T11:30:00.000Z",
      "status": "ACTIVE",
      "version": 1,
      "sectionIds": ["section_a"],
      "sectionAllocations": [{ "sectionId": "section_a", "capacity": null }]
    }
  ]
}
~~~

Inventory Service must store the source occurrence version and layout version. Duplicate event IDs are ignored. Older versions must not overwrite newer configuration. After sales start, layout changes require an explicit migration policy; the consumer must not silently delete sold/held seats.

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
