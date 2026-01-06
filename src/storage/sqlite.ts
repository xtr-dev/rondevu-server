import Database from 'better-sqlite3';
import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';

/**
 * SQLite storage adapter for rondevu signaling system
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
  }

  /**
   * Initializes database schema with Ed25519 public key identity
   */
  private initializeDatabase(): void {
    this.db.exec(`
      -- Identities table (Ed25519 public key as identity)
      CREATE TABLE IF NOT EXISTS identities (
        public_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        CHECK(length(public_key) = 64)
      );

      CREATE INDEX IF NOT EXISTS idx_identities_expires ON identities(expires_at);

      -- WebRTC signaling offers with tags
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        tags TEXT NOT NULL,
        sdp TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        answerer_public_key TEXT,
        answer_sdp TEXT,
        answered_at INTEGER,
        matched_tags TEXT,
        FOREIGN KEY (public_key) REFERENCES identities(public_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_offers_public_key ON offers(public_key);
      CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at);
      CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen);
      CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_public_key);

      -- ICE candidates table
      CREATE TABLE IF NOT EXISTS ice_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
        candidate TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_public_key ON ice_candidates(public_key);
      CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at);

      -- Rate limits table (for distributed rate limiting)
      CREATE TABLE IF NOT EXISTS rate_limits (
        identifier TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_time INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_time);

      -- Nonces table (for replay attack prevention)
      CREATE TABLE IF NOT EXISTS nonces (
        nonce_key TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at);
    `);

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
  }

  // ===== Offer Management =====

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    const created: Offer[] = [];

    // Generate hash-based IDs for all offers first
    const offersWithIds = await Promise.all(
      offers.map(async (offer) => ({
        ...offer,
        id: offer.id || await generateOfferHash(offer.sdp),
      }))
    );

    // Use transaction for atomic creation
    const transaction = this.db.transaction((offersWithIds: (CreateOfferRequest & { id: string })[]) => {
      const offerStmt = this.db.prepare(`
        INSERT INTO offers (id, public_key, tags, sdp, created_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const offer of offersWithIds) {
        const now = Date.now();

        // Insert offer with JSON-serialized tags
        offerStmt.run(
          offer.id,
          offer.publicKey,
          JSON.stringify(offer.tags),
          offer.sdp,
          now,
          offer.expiresAt,
          now
        );

        created.push({
          id: offer.id,
          publicKey: offer.publicKey,
          tags: offer.tags,
          sdp: offer.sdp,
          createdAt: now,
          expiresAt: offer.expiresAt,
          lastSeen: now,
        });
      }
    });

    transaction(offersWithIds);
    return created;
  }

  async getOffersByPublicKey(publicKey: string): Promise<Offer[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE public_key = ? AND expires_at > ?
      ORDER BY last_seen DESC
    `);

    const rows = stmt.all(publicKey, Date.now()) as any[];
    return rows.map(row => this.rowToOffer(row));
  }

  async getOfferById(offerId: string): Promise<Offer | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE id = ? AND expires_at > ?
    `);

    const row = stmt.get(offerId, Date.now()) as any;

    if (!row) {
      return null;
    }

    return this.rowToOffer(row);
  }

  async deleteOffer(offerId: string, ownerPublicKey: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      DELETE FROM offers
      WHERE id = ? AND public_key = ?
    `);

    const result = stmt.run(offerId, ownerPublicKey);
    return result.changes > 0;
  }

  async deleteExpiredOffers(now: number): Promise<number> {
    const stmt = this.db.prepare('DELETE FROM offers WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
  }

  async answerOffer(
    offerId: string,
    answererPublicKey: string,
    answerSdp: string,
    matchedTags?: string[],
    newExpiresAt?: number
  ): Promise<{ success: boolean; error?: string }> {
    // Check if offer exists and is not expired
    const offer = await this.getOfferById(offerId);

    if (!offer) {
      return {
        success: false,
        error: 'Offer not found or expired'
      };
    }

    // Check if offer already has an answerer
    if (offer.answererPublicKey) {
      return {
        success: false,
        error: 'Offer already answered'
      };
    }

    // Update offer with answer (optionally reduce TTL for faster cleanup)
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE offers
      SET answerer_public_key = ?, answer_sdp = ?, answered_at = ?, matched_tags = ?${newExpiresAt ? ', expires_at = ?' : ''}
      WHERE id = ? AND answerer_public_key IS NULL
    `);

    const matchedTagsJson = matchedTags ? JSON.stringify(matchedTags) : null;
    const params = newExpiresAt
      ? [answererPublicKey, answerSdp, now, matchedTagsJson, newExpiresAt, offerId]
      : [answererPublicKey, answerSdp, now, matchedTagsJson, offerId];
    const result = stmt.run(...params);

    if (result.changes === 0) {
      return {
        success: false,
        error: 'Offer already answered (race condition)'
      };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererPublicKey: string): Promise<Offer[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE public_key = ? AND answerer_public_key IS NOT NULL AND expires_at > ?
      ORDER BY answered_at DESC
    `);

    const rows = stmt.all(offererPublicKey, Date.now()) as any[];
    return rows.map(row => this.rowToOffer(row));
  }

  async getOffersAnsweredBy(answererPublicKey: string): Promise<Offer[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE answerer_public_key = ? AND expires_at > ?
      ORDER BY answered_at DESC
    `);

    const rows = stmt.all(answererPublicKey, Date.now()) as any[];
    return rows.map(row => this.rowToOffer(row));
  }

  // ===== Discovery =====

  async discoverOffers(
    tags: string[],
    excludePublicKey: string | null,
    limit: number,
    offset: number
  ): Promise<Offer[]> {
    if (tags.length === 0) {
      return [];
    }

    // Build query with JSON tag matching (OR logic)
    // SQLite: Use json_each() to expand tags array and check if any tag matches
    const placeholders = tags.map(() => '?').join(',');

    let query = `
      SELECT DISTINCT o.* FROM offers o, json_each(o.tags) as t
      WHERE t.value IN (${placeholders})
        AND o.expires_at > ?
        AND o.answerer_public_key IS NULL
    `;

    const params: any[] = [...tags, Date.now()];

    if (excludePublicKey) {
      query += ' AND o.public_key != ?';
      params.push(excludePublicKey);
    }

    query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.rowToOffer(row));
  }

  async getRandomOffer(
    tags: string[],
    excludePublicKey: string | null
  ): Promise<Offer | null> {
    if (tags.length === 0) {
      return null;
    }

    // Build query with JSON tag matching (OR logic)
    const placeholders = tags.map(() => '?').join(',');

    let query = `
      SELECT DISTINCT o.* FROM offers o, json_each(o.tags) as t
      WHERE t.value IN (${placeholders})
        AND o.expires_at > ?
        AND o.answerer_public_key IS NULL
    `;

    const params: any[] = [...tags, Date.now()];

    if (excludePublicKey) {
      query += ' AND o.public_key != ?';
      params.push(excludePublicKey);
    }

    query += ' ORDER BY RANDOM() LIMIT 1';

    const stmt = this.db.prepare(query);
    const row = stmt.get(...params) as any;

    return row ? this.rowToOffer(row) : null;
  }

  // ===== ICE Candidate Management =====

  async addIceCandidates(
    offerId: string,
    publicKey: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO ice_candidates (offer_id, public_key, role, candidate, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const baseTimestamp = Date.now();
    const transaction = this.db.transaction((candidates: any[]) => {
      for (let i = 0; i < candidates.length; i++) {
        stmt.run(
          offerId,
          publicKey,
          role,
          JSON.stringify(candidates[i]),
          baseTimestamp + i
        );
      }
    });

    transaction(candidates);
    return candidates.length;
  }

  async getIceCandidates(
    offerId: string,
    targetRole: 'offerer' | 'answerer',
    since?: number
  ): Promise<IceCandidate[]> {
    let query = `
      SELECT * FROM ice_candidates
      WHERE offer_id = ? AND role = ?
    `;

    const params: any[] = [offerId, targetRole];

    if (since !== undefined) {
      query += ' AND created_at > ?';
      params.push(since);
    }

    query += ' ORDER BY created_at ASC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      offerId: row.offer_id,
      publicKey: row.public_key,
      role: row.role,
      candidate: JSON.parse(row.candidate),
      createdAt: row.created_at,
    }));
  }

  async getIceCandidatesForMultipleOffers(
    offerIds: string[],
    publicKey: string,
    since?: number
  ): Promise<Map<string, IceCandidate[]>> {
    const result = new Map<string, IceCandidate[]>();

    // Return empty map if no offer IDs provided
    if (offerIds.length === 0) {
      return result;
    }

    // Validate array contains only strings
    if (!Array.isArray(offerIds) || !offerIds.every(id => typeof id === 'string')) {
      throw new Error('Invalid offer IDs: must be array of strings');
    }

    // Prevent DoS attacks from extremely large IN clauses
    if (offerIds.length > 1000) {
      throw new Error('Too many offer IDs (max 1000)');
    }

    // Build query that fetches candidates from the OTHER peer only
    // For each offer, determine if user is offerer or answerer and get opposite role
    const placeholders = offerIds.map(() => '?').join(',');

    let query = `
      SELECT ic.*, o.public_key as offer_public_key
      FROM ice_candidates ic
      INNER JOIN offers o ON o.id = ic.offer_id
      WHERE ic.offer_id IN (${placeholders})
      AND (
        (o.public_key = ? AND ic.role = 'answerer')
        OR (o.answerer_public_key = ? AND ic.role = 'offerer')
      )
    `;

    const params: any[] = [...offerIds, publicKey, publicKey];

    if (since !== undefined) {
      query += ' AND ic.created_at > ?';
      params.push(since);
    }

    query += ' ORDER BY ic.created_at ASC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    // Group candidates by offer_id
    for (const row of rows) {
      const candidate: IceCandidate = {
        id: row.id,
        offerId: row.offer_id,
        publicKey: row.public_key,
        role: row.role,
        candidate: JSON.parse(row.candidate),
        createdAt: row.created_at,
      };

      if (!result.has(row.offer_id)) {
        result.set(row.offer_id, []);
      }
      result.get(row.offer_id)!.push(candidate);
    }

    return result;
  }

  // ===== Rate Limiting =====

  async checkRateLimit(identifier: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const resetTime = now + windowMs;

    // Atomic UPSERT: Insert or increment count, reset if expired
    // This prevents TOCTOU race conditions by doing check+increment in single operation
    const result = this.db.prepare(`
      INSERT INTO rate_limits (identifier, count, reset_time)
      VALUES (?, 1, ?)
      ON CONFLICT(identifier) DO UPDATE SET
        count = CASE
          WHEN reset_time < ? THEN 1
          ELSE count + 1
        END,
        reset_time = CASE
          WHEN reset_time < ? THEN ?
          ELSE reset_time
        END
      RETURNING count
    `).get(identifier, resetTime, now, now, resetTime) as { count: number };

    // Check if limit exceeded
    return result.count <= limit;
  }

  async deleteExpiredRateLimits(now: number): Promise<number> {
    const stmt = this.db.prepare('DELETE FROM rate_limits WHERE reset_time < ?');
    const result = stmt.run(now);
    return result.changes;
  }

  // ===== Nonce Tracking (Replay Protection) =====

  async checkAndMarkNonce(nonceKey: string, expiresAt: number): Promise<boolean> {
    try {
      // Atomic INSERT - if nonce already exists, this will fail with UNIQUE constraint
      // This prevents replay attacks by ensuring each nonce is only used once
      const stmt = this.db.prepare(`
        INSERT INTO nonces (nonce_key, expires_at)
        VALUES (?, ?)
      `);
      stmt.run(nonceKey, expiresAt);
      return true; // Nonce is new, request allowed
    } catch (error: any) {
      // SQLITE_CONSTRAINT error code for UNIQUE constraint violation
      if (error?.code === 'SQLITE_CONSTRAINT') {
        return false; // Nonce already used, replay attack detected
      }
      throw error; // Other errors should propagate
    }
  }

  async deleteExpiredNonces(now: number): Promise<number> {
    const stmt = this.db.prepare('DELETE FROM nonces WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ===== Count Methods (for resource limits) =====

  async getOfferCount(): Promise<number> {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM offers').get() as { count: number };
    return result.count;
  }

  async getOfferCountByPublicKey(publicKey: string): Promise<number> {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM offers WHERE public_key = ?').get(publicKey) as { count: number };
    return result.count;
  }

  async getIceCandidateCount(offerId: string): Promise<number> {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM ice_candidates WHERE offer_id = ?').get(offerId) as { count: number };
    return result.count;
  }

  async countOffersByTags(tags: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (tags.length === 0) return result;

    const now = Date.now();

    // Query counts for each tag individually for accuracy
    // (an offer with multiple matching tags should only count once per tag)
    const stmt = this.db.prepare(`
      SELECT COUNT(DISTINCT o.id) as count
      FROM offers o, json_each(o.tags) as t
      WHERE t.value = ?
        AND o.expires_at > ?
        AND o.answerer_public_key IS NULL
    `);

    for (const tag of tags) {
      const row = stmt.get(tag, now) as { count: number };
      result.set(tag, row.count);
    }

    return result;
  }

  // ===== Helper Methods =====

  /**
   * Helper method to convert database row to Offer object
   */
  private rowToOffer(row: any): Offer {
    return {
      id: row.id,
      publicKey: row.public_key,
      tags: JSON.parse(row.tags),
      sdp: row.sdp,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeen: row.last_seen,
      answererPublicKey: row.answerer_public_key || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at || undefined,
      matchedTags: row.matched_tags ? JSON.parse(row.matched_tags) : undefined,
    };
  }
}
