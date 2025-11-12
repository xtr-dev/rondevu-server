import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Storage, Offer } from './types.ts';

/**
 * SQLite storage adapter for offer management
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
      CREATE TABLE IF NOT EXISTS offers (
        code TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        peer_id TEXT NOT NULL CHECK(length(peer_id) <= 1024),
        offer TEXT NOT NULL,
        answer TEXT,
        offer_candidates TEXT NOT NULL DEFAULT '[]',
        answer_candidates TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_offers_expires_at ON offers(expires_at);
      CREATE INDEX IF NOT EXISTS idx_offers_origin ON offers(origin);
    `);
  }

  /**
   * Starts periodic cleanup of expired offers
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

  async createOffer(origin: string, peerId: string, offer: string, expiresAt: number, customCode?: string): Promise<string> {
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
        throw new Error('Failed to generate unique offer code');
      }

      try {
        const stmt = this.db.prepare(`
          INSERT INTO offers (code, origin, peer_id, offer, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        stmt.run(code, origin, peerId, offer, Date.now(), expiresAt);
        break;
      } catch (err: any) {
        // If unique constraint failed with custom code, throw error
        if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          if (customCode) {
            throw new Error(`Offer code '${customCode}' already exists`);
          }
          // Try again with new generated code
          continue;
        }
        throw err;
      }
    } while (true);

    return code;
  }

  async getOffer(code: string, origin: string): Promise<Offer | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers WHERE code = ? AND origin = ? AND expires_at > ?
    `);

    const row = stmt.get(code, origin, Date.now()) as any;

    if (!row) {
      return null;
    }

    return {
      code: row.code,
      origin: row.origin,
      peerId: row.peer_id,
      offer: row.offer,
      answer: row.answer || undefined,
      offerCandidates: JSON.parse(row.offer_candidates),
      answerCandidates: JSON.parse(row.answer_candidates),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async updateOffer(code: string, origin: string, update: Partial<Offer>): Promise<void> {
    const current = await this.getOffer(code, origin);

    if (!current) {
      throw new Error('Offer not found or origin mismatch');
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
      UPDATE offers SET ${updates.join(', ')} WHERE code = ? AND origin = ?
    `);

    stmt.run(...values);
  }

  async deleteOffer(code: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM offers WHERE code = ?');
    stmt.run(code);
  }

  async cleanup(): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM offers WHERE expires_at <= ?');
    const result = stmt.run(Date.now());

    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} expired offer(s)`);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
