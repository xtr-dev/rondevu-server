-- Remove topics and rename sessions to offers
-- This is a breaking change requiring a fresh database

-- Drop old sessions table
DROP TABLE IF EXISTS sessions;

-- Create offers table (without topic)
CREATE TABLE offers (
  code TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  peer_id TEXT NOT NULL CHECK(length(peer_id) <= 1024),
  offer TEXT NOT NULL,
  answer TEXT,
  offer_candidates TEXT NOT NULL DEFAULT '[]',
  answer_candidates TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Create indexes for efficient queries
CREATE INDEX idx_offers_expires_at ON offers(expires_at);
CREATE INDEX idx_offers_origin ON offers(origin);
