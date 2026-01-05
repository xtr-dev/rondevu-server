-- Migration: Replace HMAC credentials with Ed25519 public key identities
-- This is a breaking change - all existing data will be lost

-- Drop existing tables (clean slate)
DROP TABLE IF EXISTS ice_candidates;
DROP TABLE IF EXISTS offers;
DROP TABLE IF EXISTS credentials;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS nonces;

-- Identities table (Ed25519 public key as identity)
CREATE TABLE identities (
  public_key TEXT PRIMARY KEY,  -- 64-char hex Ed25519 public key
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,  -- 1 year from creation/last use
  last_used INTEGER NOT NULL,
  CHECK(length(public_key) = 64)
);

CREATE INDEX idx_identities_expires ON identities(expires_at);

-- Offers table (uses public_key instead of username)
CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,  -- Owner's Ed25519 public key
  tags TEXT NOT NULL,  -- JSON array: '["tag1", "tag2"]'
  sdp TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  answerer_public_key TEXT,
  answer_sdp TEXT,
  answered_at INTEGER,
  matched_tags TEXT,  -- JSON array: tags the answerer searched for
  FOREIGN KEY (public_key) REFERENCES identities(public_key) ON DELETE CASCADE
);

CREATE INDEX idx_offers_public_key ON offers(public_key);
CREATE INDEX idx_offers_expires ON offers(expires_at);
CREATE INDEX idx_offers_last_seen ON offers(last_seen);
CREATE INDEX idx_offers_answerer ON offers(answerer_public_key);

-- ICE candidates table (uses public_key instead of username)
CREATE TABLE ice_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,
  public_key TEXT NOT NULL,  -- Sender's Ed25519 public key
  role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
  candidate TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
);

CREATE INDEX idx_ice_offer ON ice_candidates(offer_id);
CREATE INDEX idx_ice_public_key ON ice_candidates(public_key);
CREATE INDEX idx_ice_role ON ice_candidates(role);
CREATE INDEX idx_ice_created ON ice_candidates(created_at);

-- Rate limits table (unchanged)
CREATE TABLE rate_limits (
  identifier TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_time INTEGER NOT NULL
);

CREATE INDEX idx_rate_limits_reset ON rate_limits(reset_time);

-- Nonces table (unchanged)
CREATE TABLE nonces (
  nonce_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_nonces_expires ON nonces(expires_at);
