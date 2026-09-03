-- Who acted: 'human' (a signed-in person) or 'service' (a machine key). The kit's
-- audit writes 'human' when a caller names no kind, so the column default matches it.
ALTER TABLE bff_audit_log ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'human';
