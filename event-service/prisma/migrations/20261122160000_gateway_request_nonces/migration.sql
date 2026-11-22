CREATE TABLE "gateway_request_nonces" (
  "nonce" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_request_nonces_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "gateway_request_nonces_createdAt_idx"
  ON "gateway_request_nonces"("createdAt");
