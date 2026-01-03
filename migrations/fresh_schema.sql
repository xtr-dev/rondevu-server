-- Fresh schema for Rondevu (Tags-based)
-- Offers are standalone with tags for discovery

-- Drop existing tables if they exist
DROP TABLE IF EXISTS ice_candidates;
DROP TABLE IF EXISTS offers;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS credentials;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS nonces;

-- Credentials table (name + secret auth)
CREATE TABLE credentials (
  name TEXT PRIMARY KEY,
  secret TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  CHECK(length(name) >= 3 AND length(name) <= 32)
);

CREATE INDEX idx_credentials_expires ON credentials(expires_at);
CREATE INDEX idx_credentials_secret ON credentials(secret);

-- Offers table (standalone with tags for discovery)
CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  tags TEXT NOT NULL,  -- JSON array: '["tag1", "tag2"]'
  sdp TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  answerer_username TEXT,
  answer_sdp TEXT,
  answered_at INTEGER,
  FOREIGN KEY (username) REFERENCES credentials(name) ON DELETE CASCADE
);

CREATE INDEX idx_offers_username ON offers(username);
CREATE INDEX idx_offers_expires ON offers(expires_at);
CREATE INDEX idx_offers_last_seen ON offers(last_seen);
CREATE INDEX idx_offers_answerer ON offers(answerer_username);

-- ICE candidates table
CREATE TABLE ice_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
  candidate TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
);

CREATE INDEX idx_ice_offer ON ice_candidates(offer_id);
CREATE INDEX idx_ice_username ON ice_candidates(username);
CREATE INDEX idx_ice_role ON ice_candidates(role);
CREATE INDEX idx_ice_created ON ice_candidates(created_at);

-- Rate limits table
CREATE TABLE rate_limits (
  identifier TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_time INTEGER NOT NULL
);

CREATE INDEX idx_rate_limits_reset ON rate_limits(reset_time);

-- Nonces table (for replay attack prevention)
CREATE TABLE nonces (
  nonce_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_nonces_expires ON nonces(expires_at);
