# TICKETFLOW — High-Concurrency Event Ticketing Platform

> A distributed event-ticketing platform designed around concurrent seat reservations, general-admission capacity management, virtual waiting rooms, payment orchestration and reliable digital ticket issuance.

**Repository:** `Vishal-RAJ-DEV/TicketFlow`  
**Current milestone:** Phase 1 — Architecture baseline  
**Project status:** Architecture documented; application transformation has not started.

---

## Table of contents

- [Project overview](#-project-overview)
- [Product scope](#-product-scope)
- [Architecture at a glance](#-architecture-at-a-glance)
- [Core engineering principles](#-core-engineering-principles)
- [Service boundaries](#-service-boundaries)
- [Purchase workflow](#-purchase-workflow)
- [Technology stack](#-technology-stack)
- [Repository status](#-repository-status)
- [Development environment](#-development-environment)
- [Implementation roadmap](#-implementation-roadmap)
- [Architecture documentation](#-architecture-documentation)
- [Engineering standards](#-engineering-standards)

---

## 🎯 Project overview

TICKETFLOW is a multi-organizer platform for discovering and booking tickets to concerts, sports events, comedy shows, festivals and conferences.

Customers can discover events, select an event occurrence, enter a controlled sales flow when required, reserve seats or general-admission tickets, pay securely and receive digital tickets. Organizers manage events, venues, ticket categories and sales windows. Gate operators validate tickets and record entry.

The main engineering objective is to build a system that preserves business correctness under high concurrency and remains recoverable when individual services, databases, Kafka consumers or payment integrations fail.

### Core capabilities

**Customer experience**
- Event discovery by category, date, city and price.
- Event occurrence details and venue seating maps.
- Virtual waiting room for high-demand ticket releases.
- Assigned-seat reservations and general-admission purchases.
- Secure checkout, order status and payment history.
- Digital tickets with QR-based entry credentials.
- Eligible cancellations, refunds and ticket status tracking.

**Organizer experience**
- Organizer accounts and member permissions.
- Event, venue, section and seating-layout management.
- Multiple occurrences for an event.
- Ticket types, pricing, capacity and sales windows.
- Event sales and attendance reporting.

**Gate operations**
- Event/venue-scoped gate-operator access.
- QR ticket validation.
- Duplicate check-in prevention.
- Attendance and scan audit records.

---

## 🧭 Product scope

### Event versus occurrence

An **Event** is the catalog-level product, such as a concert tour. An **Event Occurrence** is one independently bookable instance at a specific venue and time.

Example:

| Event | Occurrence | Venue |
|---|---|---|
| Arijit Singh Live Tour | 15 December | Delhi |
| Arijit Singh Live Tour | 20 December | Mumbai |
| Arijit Singh Live Tour | 27 December | Bengaluru |

Inventory, queueing, booking and sales windows are scoped to an occurrence—not just the event.

### Two inventory models

| Model | How it works | Example |
|---|---|---|
| Assigned seating | Every ticket is associated with a specific physical seat | Section A, Row 5, Seat 12 |
| General admission | Customers purchase a quantity from a shared capacity pool | Standing area with 5,000 tickets |

Both models use a consistent hold/confirm/release contract while applying different allocation logic internally.

---

## 🏗️ Architecture at a glance

The target architecture contains ten deployable application services: one API Gateway and nine domain services.

~~~mermaid
flowchart TB
  C[Customer / Organizer / Gate App] --> GW[API Gateway]
  GW --> U[User Service]
  GW --> S[Search Service]
  GW --> E[Event Service]
  GW --> Q[Queue Service]
  GW --> I[Inventory Service]
  GW --> O[Order Service]
  GW --> P[Payment Service]
  GW --> T[Ticket Service]

  O <-->|Internal commands| I
  O <-->|Internal commands| P

  E -->|Catalog events| K[(Kafka)]
  I -->|Inventory events| K
  O -->|Order events| K
  P -->|Payment / refund events| K
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

### Target service map

| Service | Planned local port | Responsibility | Primary state |
|---|---:|---|---|
| API Gateway | 4000 | Routing, authentication enforcement, rate limiting and circuit breakers | Redis for rate-limit state |
| User Service | 4001 | Identity, OTP, OAuth, tokens and user profile | PostgreSQL: `user_db` |
| Search Service | 4002 | Event discovery and search projections | Elasticsearch |
| Event Service | 4003 | Organizers, events, venues, layouts, occurrences and ticket types | PostgreSQL: `event_db` |
| Notification Service | 4004 | Email delivery, templates and retries | PostgreSQL: `notification_db` |
| Order Service | 4005 | Purchase lifecycle, Saga orchestration and recovery | PostgreSQL: `order_db` |
| Payment Service | 4006 | Payment attempts, verified webhooks, refunds and audit | PostgreSQL: `payment_db` |
| Inventory Service | 4007 | Assigned seats, GA capacity shards, holds and expiry | PostgreSQL: `inventory_db` |
| Queue Service | 4008 | Waiting room, admission control and single-use tokens | Redis operational state |
| Ticket Service | 4009 | Ticket issuance, credentials, revocation and check-in | PostgreSQL: `ticket_db` |

> **Important:** These are the target service names and planned ports. The imported application directories have not yet been transformed to this target architecture. Do not treat this table as a statement that the TICKETFLOW APIs are already running.

### Data ownership

TICKETFLOW follows database-per-service ownership. Services may run on one PostgreSQL instance during local development, but each service gets a separate database and credentials. No service directly reads or writes another service's database.

- Event Service owns event/catalog configuration and venue layout.
- Inventory Service owns current allocation, holds and confirmation.
- Order Service owns customer purchase state and Saga execution.
- Payment Service owns provider payment/refund state.
- Ticket Service owns ticket credentials and check-in.
- Search Service owns a rebuildable read projection.
- Queue Service owns short-lived admission state.

---

## ⚙️ Core engineering principles

### 1. Inventory correctness first

PostgreSQL is the final authority for reservations and sales.

- Redis may provide fast advisory locks, queueing and caching.
- An acquired Redis lock is not a confirmed reservation.
- Assigned seats use row-level locking and conditional state transitions.
- General-admission capacity uses sharded counters and database constraints.
- Multi-seat or multi-shard holds are all-or-nothing transactions.

### 2. Distributed transactions with Saga

The order flow spans Inventory, Payment and Ticket services. Each service commits only to its own database. Order Service coordinates the workflow and records each step so it can retry or compensate after failures.

### 3. Transactional Outbox and Inbox

Critical business changes and outgoing events are recorded in the same local database transaction. Consumers use an Inbox/deduplication key to avoid repeating business effects when Kafka redelivers a message.

The design provides at-least-once event delivery with idempotent processing; it does not claim end-to-end exactly-once execution across databases and external providers.

### 4. Controlled admission and backpressure

A virtual waiting room protects high-demand ticket releases from sudden traffic bursts. Admission tokens are short-lived, bound to a customer and occurrence, and single-use. Joining a queue does not reserve inventory or guarantee a ticket.

### 5. Eventual consistency for read models

Elasticsearch and cached availability are read models. They may be slightly stale. Inventory Service must revalidate every purchase against authoritative database state.

### 6. Measure before scaling

The project will use load tests and observability to identify bottlenecks before introducing read replicas, database partitions or dedicated inventory shards.

---

## 🔁 Purchase workflow

The primary purchase workflow is:

1. Customer authenticates and joins a waiting room when one is enabled.
2. Queue Service issues an admission token for the selected occurrence.
3. Order Service creates an idempotent order and validates its pricing snapshot.
4. Inventory Service atomically holds the requested seats or general-admission quantity.
5. Payment Service creates a payment attempt.
6. Payment provider sends a signed webhook; Payment Service verifies and records the result.
7. Order Service resumes its Saga and asks Inventory Service to confirm the still-valid hold.
8. Ticket Service consumes the inventory-confirmed order event and issues digital tickets idempotently.
9. Order Service marks the purchase completed after ticket issuance is confirmed.
10. Notification Service delivers the ticket to the customer.

### Important failure cases

| Scenario | Expected behaviour |
|---|---|
| Two customers reserve the same seat | Only one hold succeeds |
| General-admission requests exceed capacity | Database never allows overselling |
| Payment fails | Active hold is released |
| Customer closes checkout | Hold expires and inventory is released |
| Kafka is unavailable after a database commit | Outbox publishes after recovery |
| Payment webhook is delivered repeatedly | Deduplication prevents duplicate effects |
| Payment succeeds after hold expiry | No ticket is issued; refund compensation begins |
| Ticket Service is unavailable | Issuance is retried without duplicate tickets |
| Same ticket is scanned at two gates | Exactly one check-in succeeds |

See [ORDER-SAGA.md](docs/ORDER-SAGA.md) for detailed state transitions, compensation and recovery.

---

## 🧰 Technology stack

The following technologies are selected for the target design. Some are already present in the imported codebase; new components will be introduced in their implementation phases.

| Area | Technology | Intended use |
|---|---|---|
| Backend runtime | Node.js | Service runtime |
| Backend framework | Express.js | HTTP APIs |
| ORM | Prisma | Service-owned PostgreSQL schemas |
| Relational storage | PostgreSQL | Orders, payments, inventory, catalog and tickets |
| Cache / coordination | Redis Stack | Queue state, caching, rate limits and ephemeral locks |
| Event streaming | Apache Kafka / KafkaJS | Asynchronous service communication |
| Search | Elasticsearch | Event discovery and search projections |
| Frontend | React + Vite | Customer and organizer applications |
| Styling | Tailwind CSS | Frontend styling |
| Client state | Zustand | Frontend state |
| HTTP client | Axios | API communication |
| Payments | Razorpay | Payment, webhook and refund integration |
| Containerization | Docker / Docker Compose | Local infrastructure and service development |
| Observability target | OpenTelemetry, Prometheus, Grafana | Traces, metrics and operational dashboards |
| Load testing target | k6 | Concurrency and performance testing |

---

## 📦 Repository status

The TicketFlow repository was initialized by importing the existing TRIVIO codebase. TRIVIO remains a separate project in its original repository. This repository is the target for the TICKETFLOW transformation.

### Current milestone

<badge color="success">Phase 1 — Documentation committed</badge>

The following architecture documents are available:

| Document | Purpose |
|---|---|
| [TICKETFLOW-ARCHITECTURE.md](docs/TICKETFLOW-ARCHITECTURE.md) | Target topology, service ownership and architecture decisions |
| [DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md) | Entities, relationships, business rules and invariants |
| [DATABASE-DESIGN.md](docs/DATABASE-DESIGN.md) | Database ownership, Prisma design references and constraints |
| [KAFKA-EVENT-CONTRACTS.md](docs/KAFKA-EVENT-CONTRACTS.md) | Topics, event envelope, partitioning and delivery rules |
| [ORDER-SAGA.md](docs/ORDER-SAGA.md) | Purchase state machine, compensation and failure recovery |

### Implementation status

| Component | Status |
|---|---|
| TRIVIO codebase imported into this repository | Complete |
| TICKETFLOW architecture documentation | Complete |
| TICKETFLOW domain and database design | Documented; not implemented |
| Event Service | Not started |
| Inventory transformation | Not started |
| Order / Payment Saga transformation | Not started |
| Ticket Service | Not started |
| Queue Service | Not started |
| Search and frontend transformation | Not started |
| Load tests and production hardening | Not started |

**Current-codebase warning:** Existing directories such as `admin-service`, `booking-service`, `inventory-service` and the imported frontend still contain the original railway-domain implementation. Existing railway endpoints and workflows are not TICKETFLOW APIs. They will be transformed phase by phase. The current Docker Compose file is also inherited and its project/network names will be aligned with TICKETFLOW during the infrastructure implementation work.

---

## 🖥️ Development environment

### Prerequisites

| Tool | Recommended requirement |
|---|---|
| Node.js | 18 or newer |
| npm | 9 or newer |
| Docker | 20 or newer |
| Docker Compose | Compose v2 |
| Git | 2.30 or newer |

Check local versions:

```bash
node --version
npm --version
docker --version
docker compose version
git --version
```

### Start the current local infrastructure

The existing `docker-compose.yml` currently provides development infrastructure only. It does **not** start the application microservices.

From the repository root:

```bash
docker compose up -d
docker compose ps
```

Stop the infrastructure:

```bash
docker compose down
```

Stop and remove local containers plus their named volumes (this deletes local development data):

```bash
docker compose down -v
```

### Current Docker Compose services

These are the ports defined by the inherited Compose configuration today:

| Infrastructure component | Host port(s) | Local purpose |
|---|---:|---|
| PostgreSQL 15 | 5432 | Relational databases |
| pgAdmin | 8081 | PostgreSQL administration |
| Redis Stack | 6379, 8001 | Cache/coordination and RedisInsight |
| Zookeeper | 2181 | Current Kafka broker coordination |
| Kafka | 9092 internal, 9093 host | Event streaming |
| Kafka UI | 8080 | Topic and consumer inspection |
| Elasticsearch 8.12 | 9200 | Search index |
| Kibana 8.12 | 5601 | Elasticsearch inspection |

**Local development security warning:** The inherited Compose file uses development credentials, plaintext Kafka, and Elasticsearch with security disabled. Do not expose these ports to the public internet or reuse these credentials in production. Change credentials and security settings as part of environment hardening. The Compose project/network identifiers are still inherited from TRIVIO and will be renamed in the infrastructure phase.

### Application services

Application setup and startup commands will be documented when each service is converted to TICKETFLOW. Until then, running the imported service scripts may start legacy railway workflows and should not be treated as a working TICKETFLOW deployment.

Never commit real `.env` files, payment secrets, JWT secrets or provider credentials.

---

## 🗺️ Implementation roadmap

Implementation is intentionally chunked. Each phase must have code changes, migrations where applicable, tests and a completion report before the next phase begins.

| Phase | Scope | Exit criteria |
|---|---|---|
| **1. Architecture baseline** | System architecture, domain model, database design, Kafka contracts and Order Saga | Five architecture documents reviewed and committed |
| **2. Event Service** | Organizer, venue, layout, event, occurrence, ticket types, authorization and publication | Organizer can configure and publish a valid event occurrence |
| **3. Inventory foundation** | Occurrence materialization, assigned-seat holds, GA shards, confirmation, release, expiry and inbox/outbox | Concurrency tests prove no double allocation or oversell |
| **4. Order and Payment Saga** | Order state machine, idempotency, payment attempts, webhooks, compensation and recovery | Purchase workflow recovers from injected failures |
| **5. Ticketing** | Ticket issuance, QR credentials, revocation and atomic check-in | Duplicate issuance and duplicate check-in are prevented |
| **6. Queue Service** | Waiting room, admission tokens, controlled throughput and backpressure | High-demand admission is regulated and recoverable |
| **7. Search and frontend** | Event discovery, seating experience, organizer dashboard and checkout | End-to-end TICKETFLOW purchase is usable |
| **8. Production hardening** | Observability, load tests, reconciliation, security and deployment | Measured performance and failure-test evidence is documented |

### Next implementation milestone

**Phase 2 — Event Service transformation**

The first coding chunk will inspect the imported Admin Service, Prisma setup, dependencies and event publication path. Then the railway-specific schema will be replaced with the TICKETFLOW domain model: Organizer, OrganizerMember, Venue, VenueSection, VenueSeat, Event, EventOccurrence and TicketType.

Inventory transformation will wait until the Event Service contract is stable.

---

## 📚 Architecture documentation

The `docs/` directory is the source of truth for architecture decisions:

- [System architecture](docs/TICKETFLOW-ARCHITECTURE.md)
- [Domain model and business rules](docs/DOMAIN-MODEL.md)
- [Database design and ownership](docs/DATABASE-DESIGN.md)
- [Kafka event contracts](docs/KAFKA-EVENT-CONTRACTS.md)
- [Order Saga and recovery](docs/ORDER-SAGA.md)

When implementation decisions change, update the relevant architecture document in the same phase. Documentation must describe the implemented behaviour, not an aspirational feature as if it already exists.

---

## 🧪 Engineering standards

Every implementation chunk should meet these standards:

1. **Scope control:** Change only the services/files needed for the current chunk.
2. **Database ownership:** No cross-service database access or foreign keys.
3. **Correctness:** Enforce critical invariants in database constraints and transactions, not only application checks.
4. **Idempotency:** Protect client commands, provider webhooks and Kafka consumers at their respective boundaries.
5. **Reliability:** Use Outbox/Inbox for critical event flows and document retry/recovery behaviour.
6. **Security:** Validate identity, role and resource scope in the owning service. Keep secrets out of source control and logs.
7. **Testing:** Include unit, integration and concurrency tests for relevant business rules.
8. **Observability:** Propagate correlation IDs and expose useful service, queue, database and Kafka metrics.
9. **Reviewability:** Use focused commits and keep changes on the active TICKETFLOW implementation branch.
10. **Honest reporting:** Report changed files, commands/tests run, actual results, known gaps and the next chunk. Do not claim performance or production readiness without evidence.

---

## Project direction

TICKETFLOW is being built to demonstrate practical distributed-systems engineering: inventory correctness, concurrency control, asynchronous workflows, failure recovery and measurable scalability.

The success criterion is not the number of microservices. It is a system that can reserve limited inventory correctly under contention, recover from partial failures and prove its behaviour through tests and operational measurements.
