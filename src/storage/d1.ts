import { Storage, Session } from './types.ts';

// Generate a UUID v4
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * D1 storage adapter for session management using Cloudflare D1
 */
export class D1Storage implements Storage {
  private db: D1Database;

  /**
   * Creates a new D1 storage instance
   * @param db D1Database instance from Cloudflare Workers environment
   */
  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Initializes database schema
   * This should be run once during setup, not on every request
   */
  async initializeDatabase(): Promise<void> {
    await this.db.exec(`
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

  async listTopics(origin: string, page: number = 1, limit: number = 100): Promise<{
    topics: Array<{ topic: string; count: number }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  }> {
    // Clamp limit to maximum of 1000
    const effectiveLimit = Math.min(limit, 1000);
    const offset = (page - 1) * effectiveLimit;

    try {
      // Get total count of topics for this origin
      const countResult = await this.db.prepare(`
        SELECT COUNT(DISTINCT topic) as total
        FROM sessions
        WHERE origin = ? AND expires_at > ? AND answer IS NULL
      `).bind(origin, Date.now()).first();

      const total = countResult ? Number(countResult.total) : 0;

      // Get paginated topics
      const result = await this.db.prepare(`
        SELECT topic, COUNT(*) as count
        FROM sessions
        WHERE origin = ? AND expires_at > ? AND answer IS NULL
        GROUP BY topic
        ORDER BY topic ASC
        LIMIT ? OFFSET ?
      `).bind(origin, Date.now(), effectiveLimit, offset).all();

      // D1 returns results in the results array, or empty array if no results
      if (!result.results) {
        console.error('[D1] listTopics: No results property in response:', result);
        return {
          topics: [],
          pagination: {
            page,
            limit: effectiveLimit,
            total: 0,
            hasMore: false,
          },
        };
      }

      const topics = result.results.map((row: any) => ({
        topic: row.topic,
        count: Number(row.count),
      }));

      return {
        topics,
        pagination: {
          page,
          limit: effectiveLimit,
          total,
          hasMore: offset + topics.length < total,
        },
      };
    } catch (error) {
      console.error('[D1] listTopics error:', error);
      throw error;
    }
  }

  async listSessionsByTopic(origin: string, topic: string): Promise<Session[]> {
    try {
      const result = await this.db.prepare(`
        SELECT * FROM sessions
        WHERE origin = ? AND topic = ? AND expires_at > ? AND answer IS NULL
        ORDER BY created_at DESC
      `).bind(origin, topic, Date.now()).all();

      if (!result.results) {
        console.error('[D1] listSessionsByTopic: No results property in response:', result);
        return [];
      }

      return result.results.map((row: any) => ({
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
    } catch (error) {
      console.error('[D1] listSessionsByTopic error:', error);
      throw error;
    }
  }

  async createSession(
    origin: string,
    topic: string,
    peerId: string,
    offer: string,
    expiresAt: number,
    customCode?: string
  ): Promise<string> {
    let code: string;
    let attempts = 0;
    const maxAttempts = 10;

    // Generate unique code or use custom
    do {
      code = customCode || generateUUID();
      attempts++;

      if (attempts > maxAttempts) {
        throw new Error('Failed to generate unique session code');
      }

      try {
        await this.db.prepare(`
          INSERT INTO sessions (code, origin, topic, peer_id, offer, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(code, origin, topic, peerId, offer, Date.now(), expiresAt).run();

        break;
      } catch (err: any) {
        // If unique constraint failed with custom code, throw error
        if (err.message?.includes('UNIQUE constraint failed')) {
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

  async getSession(code: string, origin: string): Promise<Session | null> {
    try {
      const result = await this.db.prepare(`
        SELECT * FROM sessions
        WHERE code = ? AND origin = ? AND expires_at > ?
      `).bind(code, origin, Date.now()).first();

      if (!result) {
        return null;
      }

      const row: any = result;

      return {
        code: row.code,
        origin: row.origin,
        topic: row.topic,
        peerId: row.peer_id,
        offer: row.offer,
        answer: row.answer || undefined,
        offerCandidates: JSON.parse(row.offer_candidates || '[]'),
        answerCandidates: JSON.parse(row.answer_candidates || '[]'),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    } catch (error) {
      console.error('[D1] getSession error:', error);
      throw error;
    }
  }

  async updateSession(code: string, origin: string, update: Partial<Session>): Promise<void> {
    // Verify session exists and origin matches
    const current = await this.getSession(code, origin);

    if (!current) {
      throw new Error('Session not found or origin mismatch');
    }

    // Build update query dynamically based on what fields are being updated
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
      return; // Nothing to update
    }

    // Add WHERE clause values
    values.push(code, origin);

    // D1 provides strong consistency, so this update is atomic and immediately visible
    const query = `
      UPDATE sessions
      SET ${updates.join(', ')}
      WHERE code = ? AND origin = ?
    `;

    await this.db.prepare(query).bind(...values).run();
  }

  async deleteSession(code: string): Promise<void> {
    await this.db.prepare(`
      DELETE FROM sessions WHERE code = ?
    `).bind(code).run();
  }

  async cleanupExpiredSessions(): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM sessions WHERE expires_at <= ?
    `).bind(Date.now()).run();

    return result.meta.changes || 0;
  }

  async cleanup(): Promise<void> {
    await this.cleanupExpiredSessions();
  }

  async close(): Promise<void> {
    // D1 doesn't require explicit connection closing
    // Connections are managed by the Cloudflare Workers runtime
  }
}
