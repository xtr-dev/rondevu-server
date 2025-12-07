-- V0.4.0 Migration: Refactor service-to-offer relationship
-- Change from one-to-one (service has offer_id) to one-to-many (offer has service_id)

-- Step 1: Add service_id column to offers table
ALTER TABLE offers ADD COLUMN service_id TEXT;

-- Step 2: Create new services table without offer_id
CREATE TABLE services_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  service_fqn TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE,
  UNIQUE(username, service_fqn)
);

-- Step 3: Copy data from old services table (if any exists)
INSERT INTO services_new (id, username, service_fqn, created_at, expires_at, is_public, metadata)
SELECT id, username, service_fqn, created_at, expires_at, is_public, metadata
FROM services;

-- Step 4: Drop old services table
DROP TABLE services;

-- Step 5: Rename new table to services
ALTER TABLE services_new RENAME TO services;

-- Step 6: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_services_username ON services(username);
CREATE INDEX IF NOT EXISTS idx_services_fqn ON services(service_fqn);
CREATE INDEX IF NOT EXISTS idx_services_expires ON services(expires_at);

-- Step 7: Add index for service_id in offers
CREATE INDEX IF NOT EXISTS idx_offers_service ON offers(service_id);

-- Step 8: Add foreign key constraint (D1 doesn't enforce FK in ALTER, but good for documentation)
-- FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
