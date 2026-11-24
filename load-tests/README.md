# TicketFlow load tests

These scripts use [k6](https://k6.io/) and target the API Gateway. Run them only against a disposable staging environment: the write tests create persistent Event Service records.

## Event catalog high-traffic profile

```bash
k6 run -e BASE_URL=https://staging.example.com -e VUS=50 -e DURATION=3m load-tests/event-catalog.js
```

Default thresholds are HTTP failure rate below 1% and p95 below 800 ms. Adjust them to the environment and agreed SLO.

## Concurrent event publication

Prepare one DRAFT event with a valid occurrence and active ticket type. All VUs intentionally publish the same event to exercise serialization and idempotency.

```bash
k6 run -e BASE_URL=https://staging.example.com -e ACCESS_TOKEN="$TOKEN" -e EVENT_ID="$DRAFT_EVENT_ID" -e VUS=20 -e DURATION=1m load-tests/event-publish-contention.js
```

## GA ticket configuration contention

Prepare a DRAFT occurrence with a published GA layout and a section with known capacity. Sales times must be within the occurrence sales window and include a timezone offset.

```bash
k6 run -e BASE_URL=https://staging.example.com -e ACCESS_TOKEN="$TOKEN" -e OCCURRENCE_ID="$DRAFT_OCCURRENCE_ID" -e GA_SECTION_ID="$SECTION_ID" -e SALES_STARTS_AT="2026-12-01T10:00:00+05:30" -e SALES_ENDS_AT="2026-12-01T18:00:00+05:30" -e ALLOCATION_PER_REQUEST=1 -e VUS=20 -e DURATION=1m load-tests/ga-ticket-type-contention.js
```

This tests the Event Service's configured GA capacity guard. It does not test live Inventory Service holds, seat locking, sale confirmation or purchase throughput; Inventory Service is not yet implemented.

Start low, increase gradually, and record commit SHA, fixture IDs, environment size, VUs, duration, p50/p95/p99, failure rate, PostgreSQL connections/lock waits and outbox age. Clean up the disposable fixture after each run.
