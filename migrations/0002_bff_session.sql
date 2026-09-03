-- 0002_bff_session.sql
--
-- The admin's server-side session store (plan §8, phase 3a; ADR-1 as revised
-- 2026-07-31). The admin no longer authenticates through Cloudflare Access — an
-- editor signs in with their own APEX STAFF credentials at /admin/login, and the
-- Apex token issued for that person is held HERE, never in the browser.
--
-- The browser holds only an opaque, httpOnly, SameSite=Strict cookie. `id` is the
-- SHA-256 of that cookie value, not the value itself, so this table is not a set of
-- live session credentials even to someone holding a copy of it.
--
-- `access_token` / `refresh_token` ARE Apex bearer credentials for one human. They
-- are scoped to that person (not a shared machine principal), they expire (Apex
-- issues 7200s access tokens), and the row is deleted on logout and on expiry.
CREATE TABLE IF NOT EXISTS bff_session (
  id                TEXT PRIMARY KEY,  -- SHA-256 (hex) of the opaque cookie value
  created_at        INTEGER NOT NULL,  -- ms since epoch
  last_seen_at      INTEGER NOT NULL,  -- ms; the idle cutoff is measured from here
  expires_at        INTEGER NOT NULL,  -- ms; the ABSOLUTE end of the session
  staff_email       TEXT NOT NULL,     -- canonical email from Apex /staffs/me
  staff_id          TEXT,              -- Apex staff uuid; recorded as the audit actor_sub
  staff_name        TEXT,              -- display name for the admin chrome
  access_token      TEXT NOT NULL,     -- the SIGNED-IN PERSON's Apex token
  token_type        TEXT NOT NULL,     -- 'Bearer'
  access_expires_at INTEGER NOT NULL,  -- ms; when the access token dies (refresh before this)
  refresh_token     TEXT NOT NULL      -- renews access_token in place, server-side only
);

-- Expiry sweeps and the "sign this person out everywhere" query both scan on these.
CREATE INDEX IF NOT EXISTS idx_bff_session_expires ON bff_session (expires_at);
CREATE INDEX IF NOT EXISTS idx_bff_session_staff ON bff_session (staff_email);
