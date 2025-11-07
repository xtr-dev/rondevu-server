import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Storage, Session } from './types.ts';

/**
 * SQLite storage adapter for session management
 * Supports both file-based and in-memory databases
 */
export class SQLiteStorage implements Storage {
  private db: Database.Database;

  /**
   * Creates a new SQLite storage instance
   * @param path Path to SQLite database file, or ':memory:' for in-memory database
   */
  constructor(path: string = ':memory:') {
    this.db = new Database(path);
    this.initializeDatabase();
    this.startCleanupInterval();
  }

  /**
   * Initializes database schema
   */
  private initializeDatabase(): void {
    this.db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_expires_at ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_origin_topic ON sessions(origin, topic);
      CREATE INDEX IF NOT EXISTS idx_origin_topic_expires ON sessions(origin, topic, expires_at);
    `);
  }

  /**
   * Starts periodic cleanup of expired sessions
   */
  private startCleanupInterval(): void {
    // Run cleanup every minute
    setInterval(() => {
      this.cleanup().catch(err => {
        console.error('Cleanup error:', err);
      });
    }, 60000);
  }

  /**
   * Generates a unique code using UUID
   */
  private generateCode(): string {
    return randomUUID();
  }

  async createSession(origin: string, topic: string, peerId: string, offer: string, expiresAt: number, customCode?: string): Promise<string> {
    // Validate peerId length
    if (peerId.length > 1024) {
      throw new Error('PeerId string must be 1024 characters or less');
    }

    let code: string;
    let attempts = 0;
    const maxAttempts = 10;

    // Try to generate or use custom code
    do {
      code = customCode || this.generateCode();
      attempts++;

      if (attempts > maxAttempts) {
        throw new Error('Failed to generate unique session code');
      }

      try {
        const stmt = this.db.prepare(`
          INSERT INTO sessions (code, origin, topic, peer_id, offer, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(code, origin, topic, peerId, offer, Date.now(), expiresAt);
        break;
      } catch (err: any) {
        // If unique constraint failed with custom code, throw error
        if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          if (customCode) {
            throw new Error(`Session code '${customCode}' already exists`);
          }
          // Try again with new generated code
          continue;
        }
        throw err;
      }
    } while (true);

    return code;
  }

  async listSessionsByTopic(origin: string, topic: string): Promise<Session[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions
      WHERE origin = ? AND topic = ? AND expires_at > ? AND answer IS NULL
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(origin, topic, Date.now()) as any[];

    return rows.map(row => ({
      code: row.code,
      origin: row.origin,
      topic: row.topic,
      peerId: row.peer_id,
      offer: row.offer,
      answer: row.answer || undefined,
      offerCandidates: JSON.parse(row.offer_candidates),
      answerCandidates: JSON.parse(row.answer_candidates),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  async listTopics(origin: string, page: number, limit: number): Promise<{
    topics: Array<{ topic: string; count: number }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  }> {
    // Ensure limit doesn't exceed 1000
    const safeLimit = Math.min(Math.max(1, limit), 1000);
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * safeLimit;

    // Get total count of topics
    const countStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT topic) as total
      FROM sessions
      WHERE origin = ? AND expires_at > ? AND answer IS NULL
    `);
    const { total } = countStmt.get(origin, Date.now()) as any;

    // Get paginated topics
    const stmt = this.db.prepare(`
      SELECT topic, COUNT(*) as count
      FROM sessions
      WHERE origin = ? AND expires_at > ? AND answer IS NULL
      GROUP BY topic
      ORDER BY topic ASC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(origin, Date.now(), safeLimit, offset) as any[];

    const topics = rows.map(row => ({
      topic: row.topic,
      count: row.count,
    }));

    return {
      topics,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        hasMore: offset + topics.length < total,
      },
    };
  }

  async getSession(code: string, origin: string): Promise<Session | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE code = ? AND origin = ? AND expires_at > ?
    `);

    const row = stmt.get(code, origin, Date.now()) as any;

    if (!row) {
      return null;
    }

    return {
      code: row.code,
      origin: row.origin,
      topic: row.topic,
      peerId: row.peer_id,
      offer: row.offer,
      answer: row.answer || undefined,
      offerCandidates: JSON.parse(row.offer_candidates),
      answerCandidates: JSON.parse(row.answer_candidates),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async updateSession(code: string, origin: string, update: Partial<Session>): Promise<void> {
    const current = await this.getSession(code, origin);

    if (!current) {
      throw new Error('Session not found or origin mismatch');
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (update.answer !== undefined) {
      updates.push('answer = ?');
      values.push(update.answer);
    }

    if (update.offerCandidates !== undefined) {
      updates.push('offer_candidates = ?');
      values.push(JSON.stringify(update.offerCandidates));
    }

    if (update.answerCandidates !== undefined) {
      updates.push('answer_candidates = ?');
      values.push(JSON.stringify(update.answerCandidates));
    }

    if (updates.length === 0) {
      return;
    }

    values.push(code);
    values.push(origin);

    const stmt = this.db.prepare(`
      UPDATE sessions SET ${updates.join(', ')} WHERE code = ? AND origin = ?
    `);

    stmt.run(...values);
  }

  async deleteSession(code: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE code = ?');
    stmt.run(code);
  }

  async cleanup(): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
    const result = stmt.run(Date.now());

    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} expired session(s)`);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
