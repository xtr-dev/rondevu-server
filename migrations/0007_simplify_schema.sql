-- V0.4.1 Migration: Simplify schema and add service discovery
-- Remove privacy layer (service_index) and add extracted fields for discovery

-- Step 1: Drop service_index table (privacy layer removal)
DROP TABLE IF EXISTS service_index;

-- Step 2: Create new services table with extracted fields for discovery
CREATE TABLE services_new (
  id TEXT PRIMARY KEY,
  service_fqn TEXT NOT NULL,
  service_name TEXT NOT NULL,
  version TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE,
  UNIQUE(service_fqn)
);

-- Step 3: Migrate existing data (if any) - parse FQN to extract components
-- Note: This migration assumes FQN format is already "service:version@username"
-- If there's old data with different format, manual intervention may be needed
INSERT INTO services_new (id, service_fqn, service_name, version, username, created_at, expires_at)
SELECT
  id,
  service_fqn,
  -- Extract service_name: everything before first ':'
  substr(service_fqn, 1, instr(service_fqn, ':') - 1) as service_name,
  -- Extract version: between ':' and '@'
  substr(
    service_fqn,
    instr(service_fqn, ':') + 1,
    instr(service_fqn, '@') - instr(service_fqn, ':') - 1
  ) as version,
  username,
  created_at,
  expires_at
FROM services
WHERE service_fqn LIKE '%:%@%'; -- Only migrate properly formatted FQNs

-- Step 4: Drop old services table
DROP TABLE services;

-- Step 5: Rename new table to services
ALTER TABLE services_new RENAME TO services;

-- Step 6: Create indexes for efficient querying
CREATE INDEX idx_services_fqn ON services(service_fqn);
CREATE INDEX idx_services_discovery ON services(service_name, version);
CREATE INDEX idx_services_username ON services(username);
CREATE INDEX idx_services_expires ON services(expires_at);

-- Step 7: Create index on offers for available offer filtering
CREATE INDEX IF NOT EXISTS idx_offers_available ON offers(answerer_peer_id) WHERE answerer_peer_id IS NULL;
