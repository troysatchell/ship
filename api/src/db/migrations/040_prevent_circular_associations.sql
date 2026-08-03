-- Migration 040: Cycle protection on document_associations (FG-14 / TRO-332)
--
-- document_associations had no cycle protection at all: A-blocks-B-blocks-A
-- (or A-project-of-B-project-of-A, etc.) was insertable through the existing
-- API. The moment any code walks the association graph outward (FleetGraph's
-- traversal, the existing /:id/context ancestors CTE in associations.ts) a
-- cycle loops until something times out or the heap runs out. This is a
-- latent defect in Ship's association model independent of any agent code.
--
-- Adapted from prevent_circular_parent() (schema.sql:165), which guards the
-- single-valued documents.parent_id column with a linear walk. This table is
-- not single-valued — a document can hold multiple outgoing edges of the same
-- relationship_type (see "Multi-parent associations" in
-- associations-regression.test.ts: an issue can belong to two projects at
-- once), so the association graph can fan out and the walk has to be a
-- visited-set BFS rather than a linear chain walk.
--
-- Scope decision (ticket asks this be answered explicitly, not silently):
-- the cycle check is scoped PER relationship_type, not across all types
-- combined. A 'parent' cycle and a 'blocks' cycle are different problems, and
-- containment types are expected to legitimately co-exist with a 'blocks'
-- edge in the reverse direction (documents.ts's own /:id/context endpoint
-- already treats 'parent'/'project'/'sprint'/'program' as distinct
-- relationships that can point in unrelated directions on the same pair of
-- documents). Checking across types would reject that legitimate coexistence
-- as a false-positive "cycle". The walk below only follows edges whose
-- relationship_type matches the edge being written.
--
-- Concurrency caveat (PM review 2026-08-03, recorded here per that review's
-- instruction): a BEFORE trigger cannot guarantee acyclicity under
-- concurrency. Two edges that each close no cycle alone but together form one
-- can still both commit: two parallel transactions each walk the graph as it
-- exists in their own snapshot, and neither sees the other's uncommitted
-- insert. A SERIALIZABLE transaction or an advisory lock keyed on the
-- relationship_type would close that race, but is not worth the added
-- contention at this write volume (association writes are low-frequency,
-- interactive, user-driven edits — not a hot path). This trigger guards the
-- common case (a single writer, or concurrent writers touching disjoint parts
-- of the graph) and is NOT a proof of acyclicity. Consequence is contained by
-- design, not by this trigger: FG-7's traversal must carry its own hard
-- document cap and its own visited-set regardless of what the database
-- promises here.

CREATE OR REPLACE FUNCTION prevent_circular_association()
RETURNS TRIGGER AS $$
DECLARE
  visited UUID[] := ARRAY[]::UUID[];
  queue UUID[] := ARRAY[NEW.related_id];
  current_id UUID;
  next_ids UUID[];
  -- Node-visit cap, not a link-count cap: bounds the BFS so a pathological
  -- graph fails fast on INSERT/UPDATE rather than hanging it. Matches
  -- prevent_circular_parent()'s max_depth=100 convention.
  max_visits INT := 100;
BEGIN
  -- Fast path: an UPDATE that leaves the edge's identity (document_id,
  -- related_id, relationship_type) untouched — e.g. a metadata-only edit —
  -- cannot introduce a cycle, so skip the walk entirely.
  IF TG_OP = 'UPDATE'
     AND OLD.document_id IS NOT DISTINCT FROM NEW.document_id
     AND OLD.related_id IS NOT DISTINCT FROM NEW.related_id
     AND OLD.relationship_type IS NOT DISTINCT FROM NEW.relationship_type THEN
    RETURN NEW;
  END IF;

  -- BFS forward from related_id, following only same-type edges. If this walk
  -- reaches document_id, then document_id is already reachable from
  -- related_id, so the edge being written (document_id -> related_id) would
  -- close a cycle: document_id -> related_id -> ... -> document_id.
  WHILE array_length(queue, 1) IS NOT NULL AND array_length(queue, 1) > 0 LOOP
    IF array_length(visited, 1) IS NOT NULL AND array_length(visited, 1) >= max_visits THEN
      RAISE EXCEPTION 'Maximum association depth (%) exceeded while checking for circular % reference', max_visits, NEW.relationship_type;
    END IF;

    current_id := queue[1];
    queue := queue[2:array_length(queue, 1)];

    IF current_id = NEW.document_id THEN
      RAISE EXCEPTION 'Circular % reference detected: document % is already reachable from % via this relationship type',
        NEW.relationship_type, NEW.document_id, NEW.related_id;
    END IF;

    IF current_id = ANY(visited) THEN
      CONTINUE;
    END IF;
    visited := visited || current_id;

    SELECT array_agg(related_id) INTO next_ids
    FROM document_associations
    WHERE document_id = current_id AND relationship_type = NEW.relationship_type;

    IF next_ids IS NOT NULL THEN
      queue := queue || next_ids;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_circular_association_trigger ON document_associations;
CREATE TRIGGER prevent_circular_association_trigger
BEFORE INSERT OR UPDATE ON document_associations
FOR EACH ROW
EXECUTE FUNCTION prevent_circular_association();
