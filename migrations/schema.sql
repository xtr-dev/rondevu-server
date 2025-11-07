-- Create sessions table
CREATE TABLE IF NOT EXISTS sessions (
  code TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  topic TEXT NOT NULL,
  peer_id TEXT NOT NULL CHECK(length(peer_id) <= 1024),
  offer TEXT NOT NULL,
  answer TEXT,
  offer_candidates TEXT NOT NULL DEFAULT '[]',
  answer_candidates TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_origin_topic ON sessions(origin, topic);
CREATE INDEX IF NOT EXISTS idx_origin_topic_expires ON sessions(origin, topic, expires_at);
