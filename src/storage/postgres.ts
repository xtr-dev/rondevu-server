import { Pool } from 'pg';
import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';

/**
 * PostgreSQL storage adapter for rondevu signaling system
 * Uses Ed25519 public key as identity (no usernames, no secrets)
 */
export class PostgreSQLStorage implements Storage {
  private pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Creates a new PostgreSQL storage instance with connection pooling
   * @param connectionString PostgreSQL connection URL
   * @param poolSize Maximum number of connections in the pool
   */
  static async create(connectionString: string, poolSize: number = 10): Promise<PostgreSQLStorage> {
    const pool = new Pool({
      connectionString,
      max: poolSize,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    const storage = new PostgreSQLStorage(pool);
    await storage.initializeDatabase();
    return storage;
  }

  private async initializeDatabase(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS identities (
          public_key CHAR(64) PRIMARY KEY,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          last_used BIGINT NOT NULL
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_identities_expires ON identities(expires_at)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS offers (
          id VARCHAR(64) PRIMARY KEY,
          public_key CHAR(64) NOT NULL REFERENCES identities(public_key) ON DELETE CASCADE,
          tags JSONB NOT NULL,
          sdp TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          last_seen BIGINT NOT NULL,
          answerer_public_key CHAR(64),
          answer_sdp TEXT,
          answered_at BIGINT,
          matched_tags JSONB
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_public_key ON offers(public_key)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_public_key)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_tags ON offers USING GIN(tags)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ice_candidates (
          id BIGSERIAL PRIMARY KEY,
          offer_id VARCHAR(64) NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
          public_key CHAR(64) NOT NULL,
          role VARCHAR(8) NOT NULL CHECK (role IN ('offerer', 'answerer')),
          candidate JSONB NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ice_public_key ON ice_candidates(public_key)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          identifier VARCHAR(255) PRIMARY KEY,
          count INT NOT NULL,
          reset_time BIGINT NOT NULL
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_time)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS nonces (
          nonce_key VARCHAR(255) PRIMARY KEY,
          expires_at BIGINT NOT NULL
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at)`);
    } finally {
      client.release();
    }
  }

  // ===== Offer Management =====

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    if (offers.length === 0) return [];

    const created: Offer[] = [];
    const now = Date.now();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const request of offers) {
        const id = request.id || await generateOfferHash(request.sdp);

        await client.query(
          `INSERT INTO offers (id, public_key, tags, sdp, created_at, expires_at, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, request.publicKey, JSON.stringify(request.tags), request.sdp, now, request.expiresAt, now]
        );

        created.push({
          id,
          publicKey: request.publicKey,
          tags: request.tags,
          sdp: request.sdp,
          createdAt: now,
          expiresAt: request.expiresAt,
          lastSeen: now,
        });
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return created;
  }

  async getOffersByPublicKey(publicKey: string): Promise<Offer[]> {
    const result = await this.pool.query(
      `SELECT * FROM offers WHERE public_key = $1 AND expires_at > $2 ORDER BY last_seen DESC`,
      [publicKey, Date.now()]
    );
    return result.rows.map(row => this.rowToOffer(row));
  }

  async getOfferById(offerId: string): Promise<Offer | null> {
    const result = await this.pool.query(
      `SELECT * FROM offers WHERE id = $1 AND expires_at > $2`,
      [offerId, Date.now()]
    );
    return result.rows.length > 0 ? this.rowToOffer(result.rows[0]) : null;
  }

  async deleteOffer(offerId: string, ownerPublicKey: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM offers WHERE id = $1 AND public_key = $2`,
      [offerId, ownerPublicKey]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateOfferTags(ownerPublicKey: string, newTags: string[]): Promise<number> {
    const result = await this.pool.query(
      `UPDATE offers SET tags = $1 WHERE public_key = $2 AND expires_at > $3`,
      [JSON.stringify(newTags), ownerPublicKey, Date.now()]
    );
    return result.rowCount ?? 0;
  }

  async deleteExpiredOffers(now: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM offers WHERE expires_at < $1`,
      [now]
    );
    return result.rowCount ?? 0;
  }

  async answerOffer(
    offerId: string,
    answererPublicKey: string,
    answerSdp: string,
    matchedTags?: string[],
    newExpiresAt?: number
  ): Promise<{ success: boolean; error?: string }> {
    const offer = await this.getOfferById(offerId);

    if (!offer) {
      return { success: false, error: 'Offer not found or expired' };
    }

    if (offer.answererPublicKey) {
      return { success: false, error: 'Offer already answered' };
    }

    const now = Date.now();
    const matchedTagsJson = matchedTags ? JSON.stringify(matchedTags) : null;

    // Optionally reduce TTL for faster cleanup after answer
    const query = newExpiresAt
      ? `UPDATE offers SET answerer_public_key = $1, answer_sdp = $2, answered_at = $3, matched_tags = $4, expires_at = $5 WHERE id = $6 AND answerer_public_key IS NULL`
      : `UPDATE offers SET answerer_public_key = $1, answer_sdp = $2, answered_at = $3, matched_tags = $4 WHERE id = $5 AND answerer_public_key IS NULL`;

    const params = newExpiresAt
      ? [answererPublicKey, answerSdp, now, matchedTagsJson, newExpiresAt, offerId]
      : [answererPublicKey, answerSdp, now, matchedTagsJson, offerId];

    const result = await this.pool.query(query, params);

    if ((result.rowCount ?? 0) === 0) {
      return { success: false, error: 'Offer already answered (race condition)' };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererPublicKey: string): Promise<Offer[]> {
    const result = await this.pool.query(
      `SELECT * FROM offers
       WHERE public_key = $1 AND answerer_public_key IS NOT NULL AND expires_at > $2
       ORDER BY answered_at DESC`,
      [offererPublicKey, Date.now()]
    );
    return result.rows.map(row => this.rowToOffer(row));
  }

  async getOffersAnsweredBy(answererPublicKey: string): Promise<Offer[]> {
    const result = await this.pool.query(
      `SELECT * FROM offers
       WHERE answerer_public_key = $1 AND expires_at > $2
       ORDER BY answered_at DESC`,
      [answererPublicKey, Date.now()]
    );
    return result.rows.map(row => this.rowToOffer(row));
  }

  // ===== Discovery =====

  async discoverOffers(
    tags: string[],
    excludePublicKey: string | null,
    limit: number,
    offset: number
  ): Promise<Offer[]> {
    if (tags.length === 0) return [];

    let query = `
      SELECT DISTINCT o.* FROM offers o
      WHERE o.tags ?| $1
        AND o.expires_at > $2
        AND o.answerer_public_key IS NULL
    `;
    const params: any[] = [tags, Date.now()];
    let paramIndex = 3;

    if (excludePublicKey) {
      query += ` AND o.public_key != $${paramIndex}`;
      params.push(excludePublicKey);
      paramIndex++;
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.rowToOffer(row));
  }

  async getRandomOffer(
    tags: string[],
    excludePublicKey: string | null
  ): Promise<Offer | null> {
    if (tags.length === 0) return null;

    let query = `
      SELECT DISTINCT o.* FROM offers o
      WHERE o.tags ?| $1
        AND o.expires_at > $2
        AND o.answerer_public_key IS NULL
    `;
    const params: any[] = [tags, Date.now()];
    let paramIndex = 3;

    if (excludePublicKey) {
      query += ` AND o.public_key != $${paramIndex}`;
      params.push(excludePublicKey);
    }

    query += ' ORDER BY RANDOM() LIMIT 1';

    const result = await this.pool.query(query, params);
    return result.rows.length > 0 ? this.rowToOffer(result.rows[0]) : null;
  }

  // ===== ICE Candidate Management =====

  async addIceCandidates(
    offerId: string,
    publicKey: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number> {
    if (candidates.length === 0) return 0;

    const baseTimestamp = Date.now();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (let i = 0; i < candidates.length; i++) {
        await client.query(
          `INSERT INTO ice_candidates (offer_id, public_key, role, candidate, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [offerId, publicKey, role, JSON.stringify(candidates[i]), baseTimestamp + i]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return candidates.length;
  }

  async getIceCandidates(
    offerId: string,
    targetRole: 'offerer' | 'answerer',
    since?: number
  ): Promise<IceCandidate[]> {
    let query = `SELECT * FROM ice_candidates WHERE offer_id = $1 AND role = $2`;
    const params: any[] = [offerId, targetRole];

    if (since !== undefined) {
      query += ' AND created_at > $3';
      params.push(since);
    }

    query += ' ORDER BY created_at ASC';

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.rowToIceCandidate(row));
  }

  async getIceCandidatesForMultipleOffers(
    offerIds: string[],
    publicKey: string,
    since?: number
  ): Promise<Map<string, IceCandidate[]>> {
    const resultMap = new Map<string, IceCandidate[]>();

    if (offerIds.length === 0) return resultMap;
    if (offerIds.length > 1000) {
      throw new Error('Too many offer IDs (max 1000)');
    }

    let query = `
      SELECT ic.*, o.public_key as offer_public_key
      FROM ice_candidates ic
      INNER JOIN offers o ON o.id = ic.offer_id
      WHERE ic.offer_id = ANY($1)
      AND (
        (o.public_key = $2 AND ic.role = 'answerer')
        OR (o.answerer_public_key = $2 AND ic.role = 'offerer')
      )
    `;
    const params: any[] = [offerIds, publicKey];

    if (since !== undefined) {
      query += ' AND ic.created_at > $3';
      params.push(since);
    }

    query += ' ORDER BY ic.created_at ASC';

    const result = await this.pool.query(query, params);

    for (const row of result.rows) {
      const candidate = this.rowToIceCandidate(row);
      if (!resultMap.has(row.offer_id)) {
        resultMap.set(row.offer_id, []);
      }
      resultMap.get(row.offer_id)!.push(candidate);
    }

    return resultMap;
  }

  // ===== Rate Limiting =====

  async checkRateLimit(identifier: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const resetTime = now + windowMs;

    const result = await this.pool.query(
      `INSERT INTO rate_limits (identifier, count, reset_time)
       VALUES ($1, 1, $2)
       ON CONFLICT (identifier) DO UPDATE SET
         count = CASE
           WHEN rate_limits.reset_time < $3 THEN 1
           ELSE rate_limits.count + 1
         END,
         reset_time = CASE
           WHEN rate_limits.reset_time < $3 THEN $2
           ELSE rate_limits.reset_time
         END
       RETURNING count`,
      [identifier, resetTime, now]
    );

    return result.rows[0].count <= limit;
  }

  async deleteExpiredRateLimits(now: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM rate_limits WHERE reset_time < $1`,
      [now]
    );
    return result.rowCount ?? 0;
  }

  // ===== Nonce Tracking (Replay Protection) =====

  async checkAndMarkNonce(nonceKey: string, expiresAt: number): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO nonces (nonce_key, expires_at) VALUES ($1, $2)`,
        [nonceKey, expiresAt]
      );
      return true;
    } catch (error: any) {
      if (error.code === '23505') {
        return false;
      }
      throw error;
    }
  }

  async deleteExpiredNonces(now: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM nonces WHERE expires_at < $1`,
      [now]
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ===== Count Methods (for resource limits) =====

  async getOfferCount(): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*) as count FROM offers');
    return Number(result.rows[0].count);
  }

  async getOfferCountByPublicKey(publicKey: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM offers WHERE public_key = $1',
      [publicKey]
    );
    return Number(result.rows[0].count);
  }

  async getIceCandidateCount(offerId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM ice_candidates WHERE offer_id = $1',
      [offerId]
    );
    return Number(result.rows[0].count);
  }

  async countOffersByTags(tags: string[], unique = false): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (tags.length === 0) return result;

    const now = Date.now();

    // Query each tag individually using JSONB containment
    for (const tag of tags) {
      const countColumn = unique ? 'COUNT(DISTINCT public_key)' : 'COUNT(DISTINCT id)';
      const queryResult = await this.pool.query(
        `SELECT ${countColumn} as count
         FROM offers
         WHERE tags ? $1
           AND expires_at > $2
           AND answerer_public_key IS NULL`,
        [tag, now]
      );
      result.set(tag, Number(queryResult.rows[0].count));
    }

    return result;
  }

  // ===== Helper Methods =====

  private rowToOffer(row: any): Offer {
    return {
      id: row.id,
      publicKey: row.public_key.trim(),
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
      sdp: row.sdp,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      lastSeen: Number(row.last_seen),
      answererPublicKey: row.answerer_public_key?.trim() || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at ? Number(row.answered_at) : undefined,
      matchedTags: row.matched_tags || undefined,
    };
  }

  private rowToIceCandidate(row: any): IceCandidate {
    return {
      id: Number(row.id),
      offerId: row.offer_id,
      publicKey: row.public_key.trim(),
      role: row.role as 'offerer' | 'answerer',
      candidate: typeof row.candidate === 'string' ? JSON.parse(row.candidate) : row.candidate,
      createdAt: Number(row.created_at),
    };
  }
}
