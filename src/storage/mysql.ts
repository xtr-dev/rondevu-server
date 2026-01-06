import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';

/**
 * MySQL storage adapter for rondevu signaling system
 * Uses Ed25519 public key as identity (no usernames, no secrets)
 */
export class MySQLStorage implements Storage {
  private pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Creates a new MySQL storage instance with connection pooling
   * @param connectionString MySQL connection URL
   * @param poolSize Maximum number of connections in the pool
   */
  static async create(connectionString: string, poolSize: number = 10): Promise<MySQLStorage> {
    const pool = mysql.createPool({
      uri: connectionString,
      waitForConnections: true,
      connectionLimit: poolSize,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    const storage = new MySQLStorage(pool);
    await storage.initializeDatabase();
    return storage;
  }

  private async initializeDatabase(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS identities (
          public_key CHAR(64) PRIMARY KEY,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          last_used BIGINT NOT NULL,
          INDEX idx_identities_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS offers (
          id VARCHAR(64) PRIMARY KEY,
          public_key CHAR(64) NOT NULL,
          tags JSON NOT NULL,
          sdp MEDIUMTEXT NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          last_seen BIGINT NOT NULL,
          answerer_public_key CHAR(64),
          answer_sdp MEDIUMTEXT,
          answered_at BIGINT,
          matched_tags JSON,
          INDEX idx_offers_public_key (public_key),
          INDEX idx_offers_expires (expires_at),
          INDEX idx_offers_last_seen (last_seen),
          INDEX idx_offers_answerer (answerer_public_key),
          FOREIGN KEY (public_key) REFERENCES identities(public_key) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS ice_candidates (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          offer_id VARCHAR(64) NOT NULL,
          public_key CHAR(64) NOT NULL,
          role ENUM('offerer', 'answerer') NOT NULL,
          candidate JSON NOT NULL,
          created_at BIGINT NOT NULL,
          INDEX idx_ice_offer (offer_id),
          INDEX idx_ice_public_key (public_key),
          INDEX idx_ice_created (created_at),
          FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          identifier VARCHAR(255) PRIMARY KEY,
          count INT NOT NULL,
          reset_time BIGINT NOT NULL,
          INDEX idx_rate_limits_reset (reset_time)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS nonces (
          nonce_key VARCHAR(255) PRIMARY KEY,
          expires_at BIGINT NOT NULL,
          INDEX idx_nonces_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    } finally {
      conn.release();
    }
  }

  // ===== Offer Management =====

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    if (offers.length === 0) return [];

    const created: Offer[] = [];
    const now = Date.now();

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const request of offers) {
        const id = request.id || await generateOfferHash(request.sdp);

        await conn.query(
          `INSERT INTO offers (id, public_key, tags, sdp, created_at, expires_at, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    return created;
  }

  async getOffersByPublicKey(publicKey: string): Promise<Offer[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM offers WHERE public_key = ? AND expires_at > ? ORDER BY last_seen DESC`,
      [publicKey, Date.now()]
    );
    return rows.map(row => this.rowToOffer(row));
  }

  async getOfferById(offerId: string): Promise<Offer | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM offers WHERE id = ? AND expires_at > ?`,
      [offerId, Date.now()]
    );
    return rows.length > 0 ? this.rowToOffer(rows[0]) : null;
  }

  async deleteOffer(offerId: string, ownerPublicKey: string): Promise<boolean> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM offers WHERE id = ? AND public_key = ?`,
      [offerId, ownerPublicKey]
    );
    return result.affectedRows > 0;
  }

  async deleteExpiredOffers(now: number): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM offers WHERE expires_at < ?`,
      [now]
    );
    return result.affectedRows;
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
      ? `UPDATE offers SET answerer_public_key = ?, answer_sdp = ?, answered_at = ?, matched_tags = ?, expires_at = ? WHERE id = ? AND answerer_public_key IS NULL`
      : `UPDATE offers SET answerer_public_key = ?, answer_sdp = ?, answered_at = ?, matched_tags = ? WHERE id = ? AND answerer_public_key IS NULL`;

    const params = newExpiresAt
      ? [answererPublicKey, answerSdp, now, matchedTagsJson, newExpiresAt, offerId]
      : [answererPublicKey, answerSdp, now, matchedTagsJson, offerId];

    const [result] = await this.pool.query<ResultSetHeader>(query, params);

    if (result.affectedRows === 0) {
      return { success: false, error: 'Offer already answered (race condition)' };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererPublicKey: string): Promise<Offer[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM offers
       WHERE public_key = ? AND answerer_public_key IS NOT NULL AND expires_at > ?
       ORDER BY answered_at DESC`,
      [offererPublicKey, Date.now()]
    );
    return rows.map(row => this.rowToOffer(row));
  }

  async getOffersAnsweredBy(answererPublicKey: string): Promise<Offer[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM offers
       WHERE answerer_public_key = ? AND expires_at > ?
       ORDER BY answered_at DESC`,
      [answererPublicKey, Date.now()]
    );
    return rows.map(row => this.rowToOffer(row));
  }

  // ===== Discovery =====

  async discoverOffers(
    tags: string[],
    excludePublicKey: string | null,
    limit: number,
    offset: number
  ): Promise<Offer[]> {
    if (tags.length === 0) return [];

    const tagArray = JSON.stringify(tags);

    let query = `
      SELECT DISTINCT o.* FROM offers o
      WHERE JSON_OVERLAPS(o.tags, ?)
        AND o.expires_at > ?
        AND o.answerer_public_key IS NULL
    `;
    const params: any[] = [tagArray, Date.now()];

    if (excludePublicKey) {
      query += ' AND o.public_key != ?';
      params.push(excludePublicKey);
    }

    query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await this.pool.query<RowDataPacket[]>(query, params);
    return rows.map(row => this.rowToOffer(row));
  }

  async getRandomOffer(
    tags: string[],
    excludePublicKey: string | null
  ): Promise<Offer | null> {
    if (tags.length === 0) return null;

    const tagArray = JSON.stringify(tags);

    let query = `
      SELECT DISTINCT o.* FROM offers o
      WHERE JSON_OVERLAPS(o.tags, ?)
        AND o.expires_at > ?
        AND o.answerer_public_key IS NULL
    `;
    const params: any[] = [tagArray, Date.now()];

    if (excludePublicKey) {
      query += ' AND o.public_key != ?';
      params.push(excludePublicKey);
    }

    query += ' ORDER BY RAND() LIMIT 1';

    const [rows] = await this.pool.query<RowDataPacket[]>(query, params);
    return rows.length > 0 ? this.rowToOffer(rows[0]) : null;
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
    const values = candidates.map((c, i) => [
      offerId,
      publicKey,
      role,
      JSON.stringify(c),
      baseTimestamp + i,
    ]);

    await this.pool.query(
      `INSERT INTO ice_candidates (offer_id, public_key, role, candidate, created_at)
       VALUES ?`,
      [values]
    );

    return candidates.length;
  }

  async getIceCandidates(
    offerId: string,
    targetRole: 'offerer' | 'answerer',
    since?: number
  ): Promise<IceCandidate[]> {
    let query = `SELECT * FROM ice_candidates WHERE offer_id = ? AND role = ?`;
    const params: any[] = [offerId, targetRole];

    if (since !== undefined) {
      query += ' AND created_at > ?';
      params.push(since);
    }

    query += ' ORDER BY created_at ASC';

    const [rows] = await this.pool.query<RowDataPacket[]>(query, params);
    return rows.map(row => this.rowToIceCandidate(row));
  }

  async getIceCandidatesForMultipleOffers(
    offerIds: string[],
    publicKey: string,
    since?: number
  ): Promise<Map<string, IceCandidate[]>> {
    const result = new Map<string, IceCandidate[]>();

    if (offerIds.length === 0) return result;
    if (offerIds.length > 1000) {
      throw new Error('Too many offer IDs (max 1000)');
    }

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

    const [rows] = await this.pool.query<RowDataPacket[]>(query, params);

    for (const row of rows) {
      const candidate = this.rowToIceCandidate(row);
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

    await this.pool.query(
      `INSERT INTO rate_limits (identifier, count, reset_time)
       VALUES (?, 1, ?)
       ON DUPLICATE KEY UPDATE
         count = IF(reset_time < ?, 1, count + 1),
         reset_time = IF(reset_time < ?, ?, reset_time)`,
      [identifier, resetTime, now, now, resetTime]
    );

    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT count FROM rate_limits WHERE identifier = ?`,
      [identifier]
    );

    return rows.length > 0 && rows[0].count <= limit;
  }

  async deleteExpiredRateLimits(now: number): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM rate_limits WHERE reset_time < ?`,
      [now]
    );
    return result.affectedRows;
  }

  // ===== Nonce Tracking (Replay Protection) =====

  async checkAndMarkNonce(nonceKey: string, expiresAt: number): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO nonces (nonce_key, expires_at) VALUES (?, ?)`,
        [nonceKey, expiresAt]
      );
      return true;
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        return false;
      }
      throw error;
    }
  }

  async deleteExpiredNonces(now: number): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM nonces WHERE expires_at < ?`,
      [now]
    );
    return result.affectedRows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ===== Count Methods (for resource limits) =====

  async getOfferCount(): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT COUNT(*) as count FROM offers');
    return Number(rows[0].count);
  }

  async getOfferCountByPublicKey(publicKey: string): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) as count FROM offers WHERE public_key = ?',
      [publicKey]
    );
    return Number(rows[0].count);
  }

  async getIceCandidateCount(offerId: string): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) as count FROM ice_candidates WHERE offer_id = ?',
      [offerId]
    );
    return Number(rows[0].count);
  }

  async countOffersByTags(tags: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (tags.length === 0) return result;

    const now = Date.now();

    // Query each tag individually using JSON_CONTAINS
    for (const tag of tags) {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(DISTINCT id) as count
         FROM offers
         WHERE JSON_CONTAINS(tags, ?)
           AND expires_at > ?
           AND answerer_public_key IS NULL`,
        [JSON.stringify(tag), now]
      );
      result.set(tag, Number(rows[0].count));
    }

    return result;
  }

  // ===== Helper Methods =====

  private rowToOffer(row: RowDataPacket): Offer {
    return {
      id: row.id,
      publicKey: row.public_key,
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
      sdp: row.sdp,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      lastSeen: Number(row.last_seen),
      answererPublicKey: row.answerer_public_key || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at ? Number(row.answered_at) : undefined,
      matchedTags: row.matched_tags ? (typeof row.matched_tags === 'string' ? JSON.parse(row.matched_tags) : row.matched_tags) : undefined,
    };
  }

  private rowToIceCandidate(row: RowDataPacket): IceCandidate {
    return {
      id: Number(row.id),
      offerId: row.offer_id,
      publicKey: row.public_key,
      role: row.role as 'offerer' | 'answerer',
      candidate: typeof row.candidate === 'string' ? JSON.parse(row.candidate) : row.candidate,
      createdAt: Number(row.created_at),
    };
  }
}
