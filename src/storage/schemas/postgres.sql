-- PostgreSQL schema for rondevu signaling system
-- Compatible with PostgreSQL 12+

-- WebRTC signaling offers with tags
CREATE TABLE IF NOT EXISTS offers (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(32) NOT NULL,
  tags JSONB NOT NULL,
  sdp TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  answerer_username VARCHAR(32),
  answer_sdp TEXT,
  answered_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_offers_username ON offers(username);
CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at);
CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen);
CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_username);
CREATE INDEX IF NOT EXISTS idx_offers_tags ON offers USING GIN(tags);

-- ICE candidates table
CREATE TABLE IF NOT EXISTS ice_candidates (
  id BIGSERIAL PRIMARY KEY,
  offer_id VARCHAR(64) NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  username VARCHAR(32) NOT NULL,
  role VARCHAR(8) NOT NULL CHECK (role IN ('offerer', 'answerer')),
  candidate JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id);
CREATE INDEX IF NOT EXISTS idx_ice_username ON ice_candidates(username);
CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at);

-- Credentials table
CREATE TABLE IF NOT EXISTS credentials (
  name VARCHAR(32) PRIMARY KEY,
  secret VARCHAR(512) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_used BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credentials_expires ON credentials(expires_at);

-- Rate limits table
CREATE TABLE IF NOT EXISTS rate_limits (
  identifier VARCHAR(255) PRIMARY KEY,
  count INT NOT NULL,
  reset_time BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_time);

-- Nonces table (replay attack prevention)
CREATE TABLE IF NOT EXISTS nonces (
  nonce_key VARCHAR(255) PRIMARY KEY,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at);
