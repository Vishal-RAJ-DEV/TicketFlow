CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
ALTER TABLE "users" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
CREATE INDEX "users_status_idx" ON "users"("status");
