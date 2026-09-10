-- 0004_bff_media_upload_claim.sql
--
-- One row per signed upload URL the media sign leg mints, so that the signed id it
-- hands the browser is bound to something and can be spent exactly once.
--
-- WHY THIS EXISTS. The sign op checks the file's type and size against the gallery
-- the caller named, then asks Apex for an ActiveStorage signed id. That signed id is
-- then a CALLER-SUPPLIED TOKEN: it comes back on the finalize request, and nothing in
-- it records which gallery it was judged for or whether it has been used. Measured
-- against local Apex before this table existed: a PNG signed for `images` finalized
-- into `videos` (200); a PDF signed for `files` finalized into `images` (200); the
-- same signed id finalized TWICE, producing two gallery items and two media sharing
-- ONE blob key, and two concurrent finalizes both succeeded. The last is the live
-- hazard: `Medium` is `has_one_attached :file, dependent: :purge_later`, so deleting
-- either item purges the bytes out from under the other.
--
-- WHY A ROW AND NOT A SIGNATURE. Binding the gallery into the signed response (an
-- HMAC the caller returns) would close the cross-gallery hole on its own, but says
-- nothing about how many times a token has been spent — and "spent once, including
-- concurrently" is a fact about the past, which a stateless token cannot carry. One
-- row closes both: the gallery is written at sign, and the redemption is a single
-- conditional UPDATE whose row-change count elects exactly one winner. D1 runs it
-- through one writer, so two concurrent finalizes cannot both see `redeemed_at IS
-- NULL` — the same primitive the ingest single-use claims already rely on.
--
-- The alternative considered and rejected — "refuse a signed id whose blob already
-- has a Medium" — needs an upstream query per finalize and still has a window between
-- the query and the create that two concurrent requests both pass through.
--
-- SHORT-LIVED BY DESIGN. A claim is swept once it expires (24h), so this table holds
-- roughly a day of uploads and never grows without bound. It stores the SHA-256 of
-- the signed id, not the signed id, so a copy of this table is not a set of live
-- capabilities to attach blobs.
CREATE TABLE IF NOT EXISTS bff_media_upload_claim (
  id          TEXT PRIMARY KEY,  -- SHA-256 (hex) of the ActiveStorage signed id
  gallery     TEXT NOT NULL,     -- the gallery name the type/size check was run against
  created_at  INTEGER NOT NULL,  -- ms since epoch
  expires_at  INTEGER NOT NULL,  -- ms; past this the claim is refused, then swept
  redeemed_at INTEGER            -- ms; NULL until finalize spends it. Set at most once.
);

-- The sweep scans on this; nothing else queries by anything but the primary key.
CREATE INDEX IF NOT EXISTS bff_media_upload_claim_expires
  ON bff_media_upload_claim (expires_at);
