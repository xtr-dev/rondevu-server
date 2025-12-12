-- Migration: Convert peer_id to username in offers and ice_candidates tables
-- This migration aligns the database with the unified Ed25519 authentication system

-- Step 1: Recreate offers table with username instead of peer_id
CREATE TABLE offers_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  service_id TEXT,
  service_fqn TEXT,
  sdp TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  answerer_username TEXT,
  answer_sdp TEXT,
  answered_at INTEGER,
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE,
  FOREIGN KEY (answerer_username) REFERENCES usernames(username) ON DELETE SET NULL
);

-- Step 2: Migrate data (if any) - peer_id becomes username
-- Note: This assumes peer_id values were already usernames in practice
INSERT INTO offers_new (id, username, service_id, service_fqn, sdp, created_at, expires_at, last_seen, answerer_username, answer_sdp, answered_at)
SELECT id, peer_id as username, service_id, NULL as service_fqn, sdp, created_at, expires_at, last_seen, answerer_peer_id as answerer_username, answer_sdp, answered_at
FROM offers;

-- Step 3: Drop old offers table
DROP TABLE offers;

-- Step 4: Rename new table
ALTER TABLE offers_new RENAME TO offers;

-- Step 5: Recreate indexes
CREATE INDEX idx_offers_username ON offers(username);
CREATE INDEX idx_offers_service ON offers(service_id);
CREATE INDEX idx_offers_expires ON offers(expires_at);
CREATE INDEX idx_offers_last_seen ON offers(last_seen);
CREATE INDEX idx_offers_answerer ON offers(answerer_username);

-- Step 6: Recreate ice_candidates table with username instead of peer_id
CREATE TABLE ice_candidates_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
  candidate TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE,
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE
);

-- Step 7: Migrate ICE candidates data
INSERT INTO ice_candidates_new (offer_id, username, role, candidate, created_at)
SELECT offer_id, peer_id as username, role, candidate, created_at
FROM ice_candidates;

-- Step 8: Drop old ice_candidates table
DROP TABLE ice_candidates;

-- Step 9: Rename new table
ALTER TABLE ice_candidates_new RENAME TO ice_candidates;

-- Step 10: Recreate indexes
CREATE INDEX idx_ice_offer ON ice_candidates(offer_id);
CREATE INDEX idx_ice_username ON ice_candidates(username);
CREATE INDEX idx_ice_role ON ice_candidates(role);
CREATE INDEX idx_ice_created ON ice_candidates(created_at);
