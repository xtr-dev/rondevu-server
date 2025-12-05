-- V2 Migration: Add offers, usernames, and services tables

-- Offers table (replaces sessions)
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  sdp TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  secret TEXT,
  answerer_peer_id TEXT,
  answer_sdp TEXT,
  answered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_offers_peer ON offers(peer_id);
CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at);
CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen);
CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_peer_id);

-- ICE candidates table
CREATE TABLE IF NOT EXISTS ice_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
  candidate TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id);
CREATE INDEX IF NOT EXISTS idx_ice_peer ON ice_candidates(peer_id);
CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at);

-- Usernames table
CREATE TABLE IF NOT EXISTS usernames (
  username TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  metadata TEXT,
  CHECK(length(username) >= 3 AND length(username) <= 32)
);

CREATE INDEX IF NOT EXISTS idx_usernames_expires ON usernames(expires_at);
CREATE INDEX IF NOT EXISTS idx_usernames_public_key ON usernames(public_key);

-- Services table
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  service_fqn TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE,
  UNIQUE(username, service_fqn)
);

CREATE INDEX IF NOT EXISTS idx_services_username ON services(username);
CREATE INDEX IF NOT EXISTS idx_services_fqn ON services(service_fqn);
CREATE INDEX IF NOT EXISTS idx_services_expires ON services(expires_at);
CREATE INDEX IF NOT EXISTS idx_services_offer ON services(offer_id);

-- Service index table (privacy layer)
CREATE TABLE IF NOT EXISTS service_index (
  uuid TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  username TEXT NOT NULL,
  service_fqn TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_service_index_username ON service_index(username);
CREATE INDEX IF NOT EXISTS idx_service_index_expires ON service_index(expires_at);
