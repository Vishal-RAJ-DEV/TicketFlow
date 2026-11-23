ALTER TABLE "venue_sections" ADD COLUMN "capacity" INTEGER;
ALTER TABLE "ticket_type_sections" ADD COLUMN "capacity" INTEGER;

ALTER TABLE "venue_sections"
  ADD CONSTRAINT "venue_sections_capacity_positive_check"
  CHECK ("capacity" IS NULL OR "capacity" > 0);

ALTER TABLE "ticket_type_sections"
  ADD CONSTRAINT "ticket_type_sections_capacity_positive_check"
  CHECK ("capacity" IS NULL OR "capacity" > 0);

-- Preserve the old single-section GA meaning where it is unambiguous.
-- Multi-section GA ticket types must be explicitly reallocated by an organizer.
UPDATE "ticket_type_sections" AS mapping
SET "capacity" = ticket_type."capacity"
FROM "ticket_types" AS ticket_type
WHERE mapping."ticketTypeId" = ticket_type."id"
  AND ticket_type."mode" = 'GENERAL_ADMISSION'
  AND (
    SELECT COUNT(*)
    FROM "ticket_type_sections" AS all_mappings
    WHERE all_mappings."ticketTypeId" = ticket_type."id"
  ) = 1;

-- Keep the original single-column Prisma relation while enforcing the
-- venue/layout pairing at the database boundary.
CREATE OR REPLACE FUNCTION enforce_occurrence_layout_venue()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_layout_venue_id TEXT;
BEGIN
  SELECT "venueId"
    INTO v_layout_venue_id
  FROM "venue_layout_versions"
  WHERE "id" = NEW."venueLayoutVersionId";

  IF NOT FOUND OR v_layout_venue_id <> NEW."venueId" THEN
    RAISE EXCEPTION 'Occurrence layout version must belong to the selected venue'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "event_occurrences_layout_venue_guard"
BEFORE INSERT OR UPDATE OF "venueId", "venueLayoutVersionId" ON "event_occurrences"
FOR EACH ROW EXECUTE FUNCTION enforce_occurrence_layout_venue();

-- Keep the occurrence as the serialization point for allocations across ticket tiers.
CREATE OR REPLACE FUNCTION enforce_ticket_type_section_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_occurrence_id TEXT;
  v_occurrence_venue_id TEXT;
  v_ticket_mode "InventoryMode";
  v_ticket_status "TicketTypeStatus";
  v_section_venue_id TEXT;
  v_section_mode "InventoryMode";
  v_section_capacity INTEGER;
  v_existing_allocation BIGINT;
BEGIN
  SELECT ticket_type."occurrenceId", ticket_type."mode", ticket_type."status", occurrence."venueId"
    INTO v_occurrence_id, v_ticket_mode, v_ticket_status, v_occurrence_venue_id
  FROM "ticket_types" AS ticket_type
  JOIN "event_occurrences" AS occurrence ON occurrence."id" = ticket_type."occurrenceId"
  WHERE ticket_type."id" = NEW."ticketTypeId"
  FOR UPDATE OF occurrence;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket type or occurrence does not exist'
      USING ERRCODE = '23503';
  END IF;

  SELECT section."venueId"
    INTO v_section_venue_id
  FROM "venue_sections" AS section
  WHERE section."id" = NEW."venueSectionId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venue section does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF v_section_venue_id <> v_occurrence_venue_id THEN
    RAISE EXCEPTION 'Ticket type section must belong to the occurrence venue'
      USING ERRCODE = '23514';
  END IF;

  -- The occurrence's immutable layout snapshot, not today's mutable venue
  -- section row, defines the section mode and capacity for this occurrence.
  SELECT
    NULLIF(snapshot_section.value->>'mode', '')::"InventoryMode",
    NULLIF(snapshot_section.value->>'capacity', '')::INTEGER
    INTO v_section_mode, v_section_capacity
  FROM "event_occurrences" AS occurrence
  JOIN "venue_layout_versions" AS layout
    ON layout."id" = occurrence."venueLayoutVersionId"
   AND layout."venueId" = occurrence."venueId"
  CROSS JOIN LATERAL jsonb_array_elements(layout."snapshot"->'sections') AS snapshot_section(value)
  WHERE occurrence."id" = v_occurrence_id
    AND snapshot_section.value->>'id' = NEW."venueSectionId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket type section is not present in the occurrence layout snapshot'
      USING ERRCODE = '23514';
  END IF;

  IF v_section_mode <> v_ticket_mode THEN
    RAISE EXCEPTION 'Ticket type mode must match the venue section mode'
      USING ERRCODE = '23514';
  END IF;

  IF v_ticket_mode = 'GENERAL_ADMISSION' THEN
    IF v_section_capacity IS NULL OR NEW."capacity" IS NULL OR NEW."capacity" < 1 THEN
      RAISE EXCEPTION 'General-admission section allocations require positive section and allocation capacities'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."capacity" > v_section_capacity THEN
      RAISE EXCEPTION 'A section allocation cannot exceed the venue section capacity'
        USING ERRCODE = '23514';
    END IF;

    IF v_ticket_status <> 'ARCHIVED' THEN
      SELECT COALESCE(SUM(existing_mapping."capacity"), 0)
        INTO v_existing_allocation
      FROM "ticket_type_sections" AS existing_mapping
      JOIN "ticket_types" AS existing_ticket_type
        ON existing_ticket_type."id" = existing_mapping."ticketTypeId"
      WHERE existing_ticket_type."occurrenceId" = v_occurrence_id
        AND existing_ticket_type."status" <> 'ARCHIVED'
        AND existing_mapping."venueSectionId" = NEW."venueSectionId"
        AND existing_mapping."ticketTypeId" <> NEW."ticketTypeId";

      IF v_existing_allocation + NEW."capacity" > v_section_capacity THEN
        RAISE EXCEPTION 'General-admission ticket allocations exceed venue section capacity'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW."capacity" IS NOT NULL THEN
    RAISE EXCEPTION 'Assigned-seat section mappings must not have a capacity allocation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ticket_type_section_allocation_guard"
BEFORE INSERT OR UPDATE ON "ticket_type_sections"
FOR EACH ROW EXECUTE FUNCTION enforce_ticket_type_section_allocation();

-- Deferred validation allows a ticket type and all its section rows to be
-- created/replaced in one transaction, then checks the final committed shape.
CREATE OR REPLACE FUNCTION validate_ticket_type_section_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_ticket_type_id TEXT;
  v_mode "InventoryMode";
  v_capacity INTEGER;
  v_mapping_count INTEGER;
  v_allocation_total BIGINT;
  v_non_null_allocations INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'ticket_types' THEN
    v_ticket_type_id := COALESCE(NEW."id", OLD."id");
  ELSE
    v_ticket_type_id := COALESCE(NEW."ticketTypeId", OLD."ticketTypeId");
  END IF;

  SELECT "mode", "capacity"
    INTO v_mode, v_capacity
  FROM "ticket_types"
  WHERE "id" = v_ticket_type_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COALESCE(SUM("capacity"), 0), COUNT("capacity")
    INTO v_mapping_count, v_allocation_total, v_non_null_allocations
  FROM "ticket_type_sections"
  WHERE "ticketTypeId" = v_ticket_type_id;

  IF v_mapping_count < 1 THEN
    RAISE EXCEPTION 'Every ticket type must have at least one eligible venue section'
      USING ERRCODE = '23514';
  END IF;

  IF v_mode = 'GENERAL_ADMISSION' THEN
    IF v_non_null_allocations <> v_mapping_count OR v_allocation_total <> v_capacity THEN
      RAISE EXCEPTION 'General-admission ticket type capacity must equal the sum of its section allocations'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_non_null_allocations <> 0 THEN
    RAISE EXCEPTION 'Assigned-seat ticket types must not define GA section allocations'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ticket_types_section_totals_check"
AFTER INSERT OR UPDATE ON "ticket_types"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ticket_type_section_totals();

CREATE CONSTRAINT TRIGGER "ticket_type_sections_totals_check"
AFTER INSERT OR UPDATE OR DELETE ON "ticket_type_sections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ticket_type_section_totals();



-- Re-activation of an archived GA tier must use the same serialization point
-- and capacity check as creating or editing its section allocations.
CREATE OR REPLACE FUNCTION enforce_ticket_type_activation_capacity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_section RECORD;
  v_existing_allocation BIGINT;
BEGIN
  IF OLD."status" = 'ARCHIVED' AND NEW."status" <> 'ARCHIVED' THEN
    PERFORM 1
    FROM "event_occurrences"
    WHERE "id" = NEW."occurrenceId"
    FOR UPDATE;

    IF NEW."mode" = 'GENERAL_ADMISSION' THEN
      FOR v_section IN
        SELECT mapping."venueSectionId", mapping."capacity",
               NULLIF(snapshot_section.value->>'capacity', '')::INTEGER AS "sectionCapacity"
        FROM "ticket_type_sections" AS mapping
        JOIN "venue_sections" AS section ON section."id" = mapping."venueSectionId"
        JOIN "event_occurrences" AS occurrence ON occurrence."id" = NEW."occurrenceId"
        JOIN "venue_layout_versions" AS layout
          ON layout."id" = occurrence."venueLayoutVersionId"
         AND layout."venueId" = occurrence."venueId"
        CROSS JOIN LATERAL jsonb_array_elements(layout."snapshot"->'sections') AS snapshot_section(value)
        WHERE mapping."ticketTypeId" = NEW."id"
          AND snapshot_section.value->>'id' = mapping."venueSectionId"
      LOOP
        SELECT COALESCE(SUM(other_mapping."capacity"), 0)
          INTO v_existing_allocation
        FROM "ticket_type_sections" AS other_mapping
        JOIN "ticket_types" AS other_ticket
          ON other_ticket."id" = other_mapping."ticketTypeId"
        WHERE other_ticket."occurrenceId" = NEW."occurrenceId"
          AND other_ticket."status" <> 'ARCHIVED'
          AND other_ticket."id" <> NEW."id"
          AND other_mapping."venueSectionId" = v_section."venueSectionId";

        IF v_section."capacity" IS NULL
           OR v_section."capacity" < 1
           OR v_section."sectionCapacity" IS NULL
           OR v_section."sectionCapacity" < 1
           OR v_section."capacity" > v_section."sectionCapacity"
           OR v_existing_allocation + v_section."capacity" > v_section."sectionCapacity" THEN
          RAISE EXCEPTION 'Reactivating this ticket type would exceed a general-admission section capacity'
            USING ERRCODE = '23514';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ticket_type_activation_capacity_guard"
BEFORE UPDATE OF "status" ON "ticket_types"
FOR EACH ROW EXECUTE FUNCTION enforce_ticket_type_activation_capacity();
