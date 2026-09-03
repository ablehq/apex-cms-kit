-- Who acted: 'editor' (a signed-in person) or 'machine' (an ingest key). GLC's
-- 0003_ingest_reservation.sql added this column already; new sites add it here.
ALTER TABLE bff_audit_log ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'editor';
