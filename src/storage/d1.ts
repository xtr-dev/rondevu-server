import { Storage, Offer } from './types.ts';

// Generate a UUID v4
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * D1 storage adapter for offer management using Cloudflare D1
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

  async createOffer(
    origin: string,
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
        throw new Error('Failed to generate unique offer code');
      }

      try {
        await this.db.prepare(`
          INSERT INTO offers (code, origin, peer_id, offer, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(code, origin, peerId, offer, Date.now(), expiresAt).run();

        break;
      } catch (err: any) {
        // If unique constraint failed with custom code, throw error
        if (err.message?.includes('UNIQUE constraint failed')) {
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
    try {
      const result = await this.db.prepare(`
        SELECT * FROM offers
        WHERE code = ? AND origin = ? AND expires_at > ?
      `).bind(code, origin, Date.now()).first();

      if (!result) {
        return null;
      }

      const row: any = result;

      return {
        code: row.code,
        origin: row.origin,
        peerId: row.peer_id,
        offer: row.offer,
        answer: row.answer || undefined,
        offerCandidates: JSON.parse(row.offer_candidates || '[]'),
        answerCandidates: JSON.parse(row.answer_candidates || '[]'),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    } catch (error) {
      console.error('[D1] getOffer error:', error);
      throw error;
    }
  }

  async updateOffer(code: string, origin: string, update: Partial<Offer>): Promise<void> {
    // Verify offer exists and origin matches
    const current = await this.getOffer(code, origin);

    if (!current) {
      throw new Error('Offer not found or origin mismatch');
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
      UPDATE offers
      SET ${updates.join(', ')}
      WHERE code = ? AND origin = ?
    `;

    await this.db.prepare(query).bind(...values).run();
  }

  async deleteOffer(code: string): Promise<void> {
    await this.db.prepare(`
      DELETE FROM offers WHERE code = ?
    `).bind(code).run();
  }

  async cleanupExpiredOffers(): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM offers WHERE expires_at <= ?
    `).bind(Date.now()).run();

    return result.meta.changes || 0;
  }

  async cleanup(): Promise<void> {
    await this.cleanupExpiredOffers();
  }

  async close(): Promise<void> {
    // D1 doesn't require explicit connection closing
    // Connections are managed by the Cloudflare Workers runtime
  }
}
