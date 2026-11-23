ALTER TABLE "event_occurrences"
  ADD COLUMN "cancelledAt" TIMESTAMPTZ(3),
  ADD COLUMN "cancellationReason" TEXT;

ALTER TABLE "outbox_events"
  ADD COLUMN "deadLetteredAt" TIMESTAMPTZ(3);

CREATE INDEX "outbox_events_published_dead_letter_next_attempt_idx"
  ON "outbox_events" ("publishedAt", "deadLetteredAt", "nextAttemptAt");
