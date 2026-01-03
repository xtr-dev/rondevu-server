-- MySQL schema for rondevu signaling system
-- Compatible with MySQL 8.0+

-- WebRTC signaling offers with tags
CREATE TABLE IF NOT EXISTS offers (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(32) NOT NULL,
  tags JSON NOT NULL,
  sdp MEDIUMTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  answerer_username VARCHAR(32),
  answer_sdp MEDIUMTEXT,
  answered_at BIGINT,
  INDEX idx_offers_username (username),
  INDEX idx_offers_expires (expires_at),
  INDEX idx_offers_last_seen (last_seen),
  INDEX idx_offers_answerer (answerer_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ICE candidates table
CREATE TABLE IF NOT EXISTS ice_candidates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  offer_id VARCHAR(64) NOT NULL,
  username VARCHAR(32) NOT NULL,
  role ENUM('offerer', 'answerer') NOT NULL,
  candidate JSON NOT NULL,
  created_at BIGINT NOT NULL,
  INDEX idx_ice_offer (offer_id),
  INDEX idx_ice_username (username),
  INDEX idx_ice_created (created_at),
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Credentials table
CREATE TABLE IF NOT EXISTS credentials (
  name VARCHAR(32) PRIMARY KEY,
  secret VARCHAR(512) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_used BIGINT NOT NULL,
  INDEX idx_credentials_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate limits table
CREATE TABLE IF NOT EXISTS rate_limits (
  identifier VARCHAR(255) PRIMARY KEY,
  count INT NOT NULL,
  reset_time BIGINT NOT NULL,
  INDEX idx_rate_limits_reset (reset_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nonces table (replay attack prevention)
CREATE TABLE IF NOT EXISTS nonces (
  nonce_key VARCHAR(255) PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  INDEX idx_nonces_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
