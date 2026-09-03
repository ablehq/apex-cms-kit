-- 0001_bff_foundation.sql
--
-- The admin BFF's own D1 (plan §8, phase 3a). SCAFFOLD ONLY: this runs against a
-- local miniflare / `wrangler dev` D1. The PRODUCTION D1 binding is a bring-up
-- config gate that is deliberately NOT provisioned here.
--
-- 2026-07-31: the Cloudflare Access applications this migration originally
-- referenced are gone (ADR-1 reversal — the admin authenticates editors against
-- Apex staff credentials). The session store that replaced them is migration 0002.

-- Append-only audit of every mutation the BFF performs. Apex keeps its own audit,
-- and since the reversal above it names the real person too (each call carries the
-- signed-in editor's own token). What this table adds is what Apex cannot see:
-- attempts that were REJECTED at the BFF and never reached Apex. Rows are only ever
-- inserted, never updated or deleted.
CREATE TABLE IF NOT EXISTS bff_audit_log (
  id          TEXT PRIMARY KEY,   -- uuid, generated per request
  occurred_at TEXT NOT NULL,      -- ISO-8601 UTC
  actor_email TEXT NOT NULL,      -- the signed-in editor's canonical Apex staff email
  actor_sub   TEXT,               -- the Apex staff uuid
  action      TEXT NOT NULL,      -- e.g. 'pages.status_event'
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  account_id  TEXT,               -- the fixed Apex account the operation targets
  page_id     TEXT,
  request_id  TEXT,               -- Cf-Ray / correlation id, for cross-referencing
  outcome     TEXT NOT NULL,      -- 'accepted' | 'rejected' | 'apex_error'
  detail      TEXT                -- small JSON string; never a secret or a token
);

CREATE INDEX IF NOT EXISTS idx_bff_audit_actor ON bff_audit_log (actor_email, occurred_at);

-- Create-serialization anchor. Dropping the Durable Object (plan §8 "No platform
-- migration") is safe because a D1 UNIQUE covers create serialization: a create
-- claims its natural key here first, and the PRIMARY KEY makes two concurrent
-- creates race to a single winner. It is also the trust anchor for "has this exact
-- create already happened?". No create route ships in the 3a scaffold — the table
-- and its invariant are reserved so the write route can rely on them when it lands.
CREATE TABLE IF NOT EXISTS bff_reservation (
  reservation_key TEXT PRIMARY KEY,  -- e.g. 'page:slug:/our-story'
  claimed_at      TEXT NOT NULL,
  claimed_by      TEXT NOT NULL,     -- verified actor email
  resource_id     TEXT               -- the Apex id, once the create succeeds
);
