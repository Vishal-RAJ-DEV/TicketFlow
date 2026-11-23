# Production deployment and security

This overlay is a deployment template for the Event Service and API Gateway. It does not provision a database, Kafka, Redis, the User Service, an ingress controller, certificates, or a secret manager. Those dependencies must be deployed on the private backend network before starting this stack.

## Network boundary

Create two Docker networks before deployment:

- `ticketflow-edge`: attach the TLS-terminating ingress/reverse proxy and API Gateway.
- `ticketflow-backend`: attach API Gateway, Event Service, User Service, private Redis, PostgreSQL, and Kafka.

Only API Gateway joins both networks. Event Service joins only the backend network and has no host port published. The ingress should be the only public entry point; it terminates HTTPS for browsers and forwards to API Gateway on the edge network. Do not attach databases or Kafka to the edge network.

## TLS and mTLS

The Gateway-to-Event-Service link is HTTPS with mutual TLS. Use certificates with correct DNS SANs:

- Event Service server certificate SAN includes `event-service`.
- Gateway client certificate has subject CN `ticketflow-api-gateway`.
- The Event Service trusts only the CA that issued Gateway client certificates.
- The Gateway trusts only the CA that issued the Event Service server certificate.

The Event Service listener requires a trusted client certificate for every business, metrics, and ops request. Only liveness/readiness endpoints bypass client-certificate authorization so orchestrators can probe the process. Private keys must be unencrypted PEM files readable by the container's non-root runtime user. Mount them through a secrets manager; never commit them.

## Kafka authentication

Event Service supports KafkaJS TLS and SASL `SCRAM-SHA-512`, with optional client certificates. Production configuration rejects PLAINTEXT Kafka, missing SASL credentials, and auto-topic creation. Provision topics and ACLs ahead of deployment. Grant this service only the write permissions it needs for the Event Service event topics.

## Secret provisioning

Create the files referenced by the production Compose variables. Each file should contain one value and may end with a newline. Required values include:

- Event Service database URL and Gateway assertion HMAC key.
- User Service internal service key.
- Gateway JWT access and refresh signing secrets.
- Gateway client certificate/key and Event Service server certificate/key.
- Separate CA certificates for the Gateway client identity, Event Service server identity, and Kafka.
- Kafka SASL password, Event Service ops token, metrics token, and Redis URL.

The Compose overlay deliberately requires a previous Gateway assertion secret file; create an empty file when no rotation is in progress.

Generate secrets from a cryptographically secure source, e.g. `openssl rand -hex 32`. Do not reuse the JWT keys, Gateway assertion key, User Service key, ops token, metrics token, Kafka password, or database credentials.

## Rotation procedure

1. Create a new secret and configure the receiving service to accept both current and previous keys.
2. Roll out the receiver first (Event Service for Gateway assertions; User Service for internal service authentication).
3. Switch the caller to the new key and roll it out.
4. Verify authentication, then remove the previous key after the maximum request lifetime plus deployment overlap.
5. Revoke the old secret at the secret manager.

Gateway assertions are timestamp-bound and single-use via the database nonce table. Replayed nonces are rejected across all Event Service replicas.

## Outbox operations

The following endpoints are intentionally absent from API Gateway routes:

- `GET /internal/metrics`: Prometheus text format, requires `X-Metrics-Token`.
- `GET /internal/ops/outbox`: pending/published/dead-letter counts, requires `Authorization: Bearer <EVENT_SERVICE_OPS_TOKEN>`.
- `GET /internal/ops/outbox/dead-letters`: lists dead-lettered events.
- `POST /internal/ops/outbox/dead-letters/:eventId/retry`: requeues an unpublished dead-lettered event.

Restrict these paths to the backend network and authorized scrapers/operators. Alert on non-zero dead-letter count and sustained growth in oldest pending event age. A requeue is an operator action; inspect the cause before retrying poison events.

## Deployment checklist

- [ ] Provision the two private networks and attach ingress/dependencies correctly.
- [ ] Provision and rotate all secrets using a secret manager.
- [ ] Provision PostgreSQL with backups, TLS, least-privilege credentials, and tested restore.
- [ ] Provision Kafka with TLS/SASL, topic ACLs, partition/replication policy, and monitoring.
- [ ] Provision Redis with TLS/authentication and persistence appropriate to gateway rate limiting.
- [ ] Configure ingress TLS, host allowlists, request-size limits, and WAF/rate limiting.
- [ ] Ensure only ingress and approved operator/scraper paths can reach the stack.
- [ ] Verify metrics, outbox alerting, logs, traces, and an incident runbook before public traffic.
