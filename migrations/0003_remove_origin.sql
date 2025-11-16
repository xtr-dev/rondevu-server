-- Migration: Remove origin column from offers table
-- This simplifies offer lookup to only use offer codes
-- Origin-based bucketing is no longer needed

-- Create new offers table without origin column
CREATE TABLE offers_new (
  code TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL CHECK(length(peer_id) <= 1024),
  offer TEXT NOT NULL,
  answer TEXT,
  offer_candidates TEXT NOT NULL DEFAULT '[]',
  answer_candidates TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Copy data from old table
INSERT INTO offers_new (code, peer_id, offer, answer, offer_candidates, answer_candidates, created_at, expires_at)
SELECT code, peer_id, offer, answer, offer_candidates, answer_candidates, created_at, expires_at
FROM offers;

-- Drop old table
DROP TABLE offers;

-- Rename new table
ALTER TABLE offers_new RENAME TO offers;

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_offers_expires_at ON offers(expires_at);
