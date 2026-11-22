CREATE TYPE "OrganizerStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "OrganizerRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER');
CREATE TYPE "VenueStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "VenueLayoutVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "InventoryMode" AS ENUM ('ASSIGNED', 'GENERAL_ADMISSION');
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "OccurrenceStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ON_SALE', 'SALES_CLOSED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "TicketTypeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'SALES_CLOSED', 'ARCHIVED');

CREATE TABLE "organizers" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "contactEmail" TEXT,
  "websiteUrl" TEXT,
  "ownerId" TEXT NOT NULL,
  "status" "OrganizerStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "organizers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organizers_slug_key" ON "organizers"("slug");
CREATE INDEX "organizers_ownerId_idx" ON "organizers"("ownerId");
CREATE INDEX "organizers_status_createdAt_idx" ON "organizers"("status", "createdAt");

CREATE TABLE "organizer_members" (
  "id" TEXT NOT NULL,
  "organizerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "OrganizerRole" NOT NULL DEFAULT 'VIEWER',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "organizer_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organizer_members_organizerId_userId_key" ON "organizer_members"("organizerId", "userId");
CREATE INDEX "organizer_members_userId_idx" ON "organizer_members"("userId");
ALTER TABLE "organizer_members" ADD CONSTRAINT "organizer_members_organizerId_fkey"
  FOREIGN KEY ("organizerId") REFERENCES "organizers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "venues" (
  "id" TEXT NOT NULL,
  "organizerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "state" TEXT,
  "country" TEXT NOT NULL DEFAULT 'India',
  "postalCode" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  "description" TEXT,
  "status" "VenueStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "venues_organizerId_status_idx" ON "venues"("organizerId", "status");
CREATE INDEX "venues_city_name_idx" ON "venues"("city", "name");
ALTER TABLE "venues" ADD CONSTRAINT "venues_organizerId_fkey"
  FOREIGN KEY ("organizerId") REFERENCES "organizers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "venue_layout_versions" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "VenueLayoutVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "snapshot" JSONB,
  "createdBy" TEXT NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "venue_layout_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "venue_layout_versions_venueId_version_key" ON "venue_layout_versions"("venueId", "version");
CREATE INDEX "venue_layout_versions_venueId_status_idx" ON "venue_layout_versions"("venueId", "status");
ALTER TABLE "venue_layout_versions" ADD CONSTRAINT "venue_layout_versions_version_check" CHECK ("version" > 0);
ALTER TABLE "venue_layout_versions" ADD CONSTRAINT "venue_layout_versions_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "venue_sections" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "mode" "InventoryMode" NOT NULL,
  "description" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "venue_sections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "venue_sections_venueId_name_key" ON "venue_sections"("venueId", "name");
CREATE UNIQUE INDEX "venue_sections_venueId_code_key" ON "venue_sections"("venueId", "code");
CREATE INDEX "venue_sections_venueId_mode_isActive_idx" ON "venue_sections"("venueId", "mode", "isActive");
ALTER TABLE "venue_sections" ADD CONSTRAINT "venue_sections_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "venue_seats" (
  "id" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "rowLabel" TEXT NOT NULL,
  "seatLabel" TEXT NOT NULL,
  "x" DOUBLE PRECISION,
  "y" DOUBLE PRECISION,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "venue_seats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "venue_seats_sectionId_rowLabel_seatLabel_key" ON "venue_seats"("sectionId", "rowLabel", "seatLabel");
CREATE INDEX "venue_seats_sectionId_isActive_idx" ON "venue_seats"("sectionId", "isActive");
ALTER TABLE "venue_seats" ADD CONSTRAINT "venue_seats_sectionId_fkey"
  FOREIGN KEY ("sectionId") REFERENCES "venue_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "events" (
  "id" TEXT NOT NULL,
  "organizerId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT NOT NULL,
  "posterImageUrl" TEXT,
  "bannerImageUrl" TEXT,
  "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "publishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "events_slug_key" ON "events"("slug");
CREATE INDEX "events_organizerId_status_idx" ON "events"("organizerId", "status");
CREATE INDEX "events_category_status_idx" ON "events"("category", "status");
CREATE INDEX "events_status_publishedAt_idx" ON "events"("status", "publishedAt");
ALTER TABLE "events" ADD CONSTRAINT "events_version_check" CHECK ("version" > 0);
ALTER TABLE "events" ADD CONSTRAINT "events_organizerId_fkey"
  FOREIGN KEY ("organizerId") REFERENCES "organizers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "event_occurrences" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "venueLayoutVersionId" TEXT NOT NULL,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "salesOpenAt" TIMESTAMPTZ(3) NOT NULL,
  "salesCloseAt" TIMESTAMPTZ(3) NOT NULL,
  "status" "OccurrenceStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "publishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "event_occurrences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "event_occurrences_eventId_startsAt_key" ON "event_occurrences"("eventId", "startsAt");
CREATE INDEX "event_occurrences_venueId_startsAt_idx" ON "event_occurrences"("venueId", "startsAt");
CREATE INDEX "event_occurrences_status_salesOpenAt_idx" ON "event_occurrences"("status", "salesOpenAt");
CREATE INDEX "event_occurrences_eventId_status_idx" ON "event_occurrences"("eventId", "status");
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_version_check" CHECK ("version" > 0);
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_time_window_check"
  CHECK ("endsAt" > "startsAt" AND "salesCloseAt" > "salesOpenAt" AND "salesCloseAt" <= "startsAt");
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_venueLayoutVersionId_fkey"
  FOREIGN KEY ("venueLayoutVersionId") REFERENCES "venue_layout_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ticket_types" (
  "id" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "mode" "InventoryMode" NOT NULL,
  "priceMinorUnits" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "capacity" INTEGER,
  "minPerOrder" INTEGER NOT NULL DEFAULT 1,
  "maxPerOrder" INTEGER NOT NULL DEFAULT 6,
  "salesStartsAt" TIMESTAMPTZ(3) NOT NULL,
  "salesEndsAt" TIMESTAMPTZ(3) NOT NULL,
  "status" "TicketTypeStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_types_occurrenceId_code_key" ON "ticket_types"("occurrenceId", "code");
CREATE INDEX "ticket_types_occurrenceId_status_idx" ON "ticket_types"("occurrenceId", "status");
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_configuration_check"
  CHECK (
    "priceMinorUnits" >= 0
    AND "minPerOrder" > 0
    AND "maxPerOrder" >= "minPerOrder"
    AND "salesEndsAt" > "salesStartsAt"
    AND "version" > 0
    AND (
      ("mode" = 'GENERAL_ADMISSION' AND "capacity" IS NOT NULL AND "capacity" > 0)
      OR ("mode" = 'ASSIGNED' AND "capacity" IS NULL)
    )
  );
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_occurrenceId_fkey"
  FOREIGN KEY ("occurrenceId") REFERENCES "event_occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ticket_type_sections" (
  "id" TEXT NOT NULL,
  "ticketTypeId" TEXT NOT NULL,
  "venueSectionId" TEXT NOT NULL,
  CONSTRAINT "ticket_type_sections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_type_sections_ticketTypeId_venueSectionId_key" ON "ticket_type_sections"("ticketTypeId", "venueSectionId");
CREATE INDEX "ticket_type_sections_venueSectionId_idx" ON "ticket_type_sections"("venueSectionId");
ALTER TABLE "ticket_type_sections" ADD CONSTRAINT "ticket_type_sections_ticketTypeId_fkey"
  FOREIGN KEY ("ticketTypeId") REFERENCES "ticket_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_type_sections" ADD CONSTRAINT "ticket_type_sections_venueSectionId_fkey"
  FOREIGN KEY ("venueSectionId") REFERENCES "venue_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "outbox_events" (
  "id" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "aggregateVersion" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outbox_events_publishedAt_nextAttemptAt_idx" ON "outbox_events"("publishedAt", "nextAttemptAt");
CREATE INDEX "outbox_events_aggregateId_aggregateVersion_idx" ON "outbox_events"("aggregateId", "aggregateVersion");
CREATE INDEX "outbox_events_lockedAt_idx" ON "outbox_events"("lockedAt");
