-- Drop old sessions table with 'info' column
DROP TABLE IF EXISTS sessions;

-- Create sessions table with peer_id column
CREATE TABLE sessions (
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
CREATE INDEX idx_expires_at ON sessions(expires_at);
CREATE INDEX idx_origin_topic ON sessions(origin, topic);
CREATE INDEX idx_origin_topic_expires ON sessions(origin, topic, expires_at);
