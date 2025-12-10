-- Fresh schema for Rondevu v0.5.0+
-- Unified Ed25519 authentication - username/keypair only
-- This is the complete schema without migration steps

-- Drop existing tables if they exist
DROP TABLE IF EXISTS ice_candidates;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS offers;
DROP TABLE IF EXISTS usernames;

-- Usernames table (now required for all users, even anonymous)
CREATE TABLE usernames (
  username TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  metadata TEXT,
  CHECK(length(username) >= 3 AND length(username) <= 32)
);

CREATE INDEX idx_usernames_expires ON usernames(expires_at);
CREATE INDEX idx_usernames_public_key ON usernames(public_key);

-- Services table with discovery fields
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  service_fqn TEXT NOT NULL,
  service_name TEXT NOT NULL,
  version TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE,
  UNIQUE(service_name, version, username)
);

CREATE INDEX idx_services_fqn ON services(service_fqn);
CREATE INDEX idx_services_discovery ON services(service_name, version);
CREATE INDEX idx_services_username ON services(username);
CREATE INDEX idx_services_expires ON services(expires_at);

-- Offers table (now uses username instead of peer_id)
CREATE TABLE offers (
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

CREATE INDEX idx_offers_username ON offers(username);
CREATE INDEX idx_offers_service ON offers(service_id);
CREATE INDEX idx_offers_expires ON offers(expires_at);
CREATE INDEX idx_offers_last_seen ON offers(last_seen);
CREATE INDEX idx_offers_answerer ON offers(answerer_username);

-- ICE candidates table (now uses username instead of peer_id)
CREATE TABLE ice_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
  candidate TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE,
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE
);

CREATE INDEX idx_ice_offer ON ice_candidates(offer_id);
CREATE INDEX idx_ice_username ON ice_candidates(username);
CREATE INDEX idx_ice_role ON ice_candidates(role);
CREATE INDEX idx_ice_created ON ice_candidates(created_at);
