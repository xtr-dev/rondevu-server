import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
  Credential,
  GenerateCredentialsRequest,
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';

const YEAR_IN_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * MySQL storage adapter for rondevu signaling system
 * Uses connection pooling for efficient resource management
 */
export class MySQLStorage implements Storage {
  private pool: Pool;
  private masterEncryptionKey: string;

  private constructor(pool: Pool, masterEncryptionKey: string) {
    this.pool = pool;
    this.masterEncryptionKey = masterEncryptionKey;
  }

  /**
   * Creates a new MySQL storage instance with connection pooling
   * @param connectionString MySQL connection URL
   * @param masterEncryptionKey 64-char hex string for encrypting secrets
   * @param poolSize Maximum number of connections in the pool
   */
  static async create(
    connectionString: string,
    masterEncryptionKey: string,
    poolSize: number = 10
  ): Promise<MySQLStorage> {
    const pool = mysql.createPool({
      uri: connectionString,
      waitForConnections: true,
      connectionLimit: poolSize,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    const storage = new MySQLStorage(pool, masterEncryptionKey);
    await storage.initializeDatabase();
    return storage;
  }

  private async initializeDatabase(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await conn.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS credentials (
          name VARCHAR(32) PRIMARY KEY,
          secret VARCHAR(512) NOT NULL UNIQUE,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          last_used BIGINT NOT NULL,
          INDEX idx_credentials_expires (expires_at)
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
          `INSERT INTO offers (id, username, tags, sdp, created_at, expires_at, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, request.username, JSON.stringify(request.tags), request.sdp, now, request.expiresAt, now]
        );

        created.push({
          id,
          username: request.username,
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

  async getOffersByUsername(username: string): Promise<Offer[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM offers WHERE username = ? AND expires_at > ? ORDER BY last_seen DESC`,
      [username, Date.now()]
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

  async deleteOffer(offerId: string, ownerUsername: string): Promise<boolean> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM offers WHERE id = ? AND username = ?`,
      [offerId, ownerUsername]
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
    answererUsername: string,
    answerSdp: string
  ): Promise<{ success: boolean; error?: string }> {
    const offer = await this.getOfferById(offerId);

    if (!offer) {
      return { success: false, error: 'Offer not found or expired' };
    }

    if (offer.answererUsername) {
      return { success: false, error: 'Offer already answered' };
    }

    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE offers SET answerer_username = ?, answer_sdp = ?, answered_at = ?
       WHERE id = ? AND answerer_username IS NULL`,
      [answererUsername, answerSdp, Date.now(), offerId]
    );

    if (result.affectedRows === 0) {
      return { success: false, error: 'Offer already answered (race condition)' };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererUsername: string): Promise<Offer[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM offers
       WHERE username = ? AND answerer_username IS NOT NULL AND expires_at > ?
       ORDER BY answered_at DESC`,
      [offererUsername, Date.now()]
    );
    return rows.map(row => this.rowToOffer(row));
  }

  async getOffersAnsweredBy(answererUsername: string): Promise<Offer[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM offers
       WHERE answerer_username = ? AND expires_at > ?
       ORDER BY answered_at DESC`,
      [answererUsername, Date.now()]
    );
    return rows.map(row => this.rowToOffer(row));
  }

  // ===== Discovery =====

  async discoverOffers(
    tags: string[],
    excludeUsername: string | null,
    limit: number,
    offset: number
  ): Promise<Offer[]> {
    if (tags.length === 0) return [];

    // Use JSON_OVERLAPS for efficient tag matching (MySQL 8.0.17+)
    // Falls back to JSON_CONTAINS for each tag with OR logic
    const tagArray = JSON.stringify(tags);

    let query = `
      SELECT DISTINCT o.* FROM offers o
      WHERE JSON_OVERLAPS(o.tags, ?)
        AND o.expires_at > ?
        AND o.answerer_username IS NULL
    `;
    const params: any[] = [tagArray, Date.now()];

    if (excludeUsername) {
      query += ' AND o.username != ?';
      params.push(excludeUsername);
    }

    query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await this.pool.query<RowDataPacket[]>(query, params);
    return rows.map(row => this.rowToOffer(row));
  }

  async getRandomOffer(
    tags: string[],
    excludeUsername: string | null
  ): Promise<Offer | null> {
    if (tags.length === 0) return null;

    const tagArray = JSON.stringify(tags);

    let query = `
      SELECT DISTINCT o.* FROM offers o
      WHERE JSON_OVERLAPS(o.tags, ?)
        AND o.expires_at > ?
        AND o.answerer_username IS NULL
    `;
    const params: any[] = [tagArray, Date.now()];

    if (excludeUsername) {
      query += ' AND o.username != ?';
      params.push(excludeUsername);
    }

    query += ' ORDER BY RAND() LIMIT 1';

    const [rows] = await this.pool.query<RowDataPacket[]>(query, params);
    return rows.length > 0 ? this.rowToOffer(rows[0]) : null;
  }

  // ===== ICE Candidate Management =====

  async addIceCandidates(
    offerId: string,
    username: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number> {
    if (candidates.length === 0) return 0;

    const baseTimestamp = Date.now();
    const values = candidates.map((c, i) => [
      offerId,
      username,
      role,
      JSON.stringify(c),
      baseTimestamp + i,
    ]);

    await this.pool.query(
      `INSERT INTO ice_candidates (offer_id, username, role, candidate, created_at)
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
    username: string,
    since?: number
  ): Promise<Map<string, IceCandidate[]>> {
    const result = new Map<string, IceCandidate[]>();

    if (offerIds.length === 0) return result;
    if (offerIds.length > 1000) {
      throw new Error('Too many offer IDs (max 1000)');
    }

    const placeholders = offerIds.map(() => '?').join(',');

    let query = `
      SELECT ic.*, o.username as offer_username
      FROM ice_candidates ic
      INNER JOIN offers o ON o.id = ic.offer_id
      WHERE ic.offer_id IN (${placeholders})
      AND (
        (o.username = ? AND ic.role = 'answerer')
        OR (o.answerer_username = ? AND ic.role = 'offerer')
      )
    `;
    const params: any[] = [...offerIds, username, username];

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

  // ===== Credential Management =====

  async generateCredentials(request: GenerateCredentialsRequest): Promise<Credential> {
    const now = Date.now();
    const expiresAt = request.expiresAt || (now + YEAR_IN_MS);

    const { generateCredentialName, generateSecret, encryptSecret } = await import('../crypto.ts');

    let name: string;

    if (request.name) {
      const [existing] = await this.pool.query<RowDataPacket[]>(
        `SELECT name FROM credentials WHERE name = ?`,
        [request.name]
      );

      if (existing.length > 0) {
        throw new Error('Username already taken');
      }

      name = request.name;
    } else {
      let attempts = 0;
      const maxAttempts = 100;

      while (attempts < maxAttempts) {
        name = generateCredentialName();

        const [existing] = await this.pool.query<RowDataPacket[]>(
          `SELECT name FROM credentials WHERE name = ?`,
          [name]
        );

        if (existing.length === 0) break;
        attempts++;
      }

      if (attempts >= maxAttempts) {
        throw new Error(`Failed to generate unique credential name after ${maxAttempts} attempts`);
      }
    }

    const secret = generateSecret();
    const encryptedSecret = await encryptSecret(secret, this.masterEncryptionKey);

    await this.pool.query(
      `INSERT INTO credentials (name, secret, created_at, expires_at, last_used)
       VALUES (?, ?, ?, ?, ?)`,
      [name!, encryptedSecret, now, expiresAt, now]
    );

    return {
      name: name!,
      secret,
      createdAt: now,
      expiresAt,
      lastUsed: now,
    };
  }

  async getCredential(name: string): Promise<Credential | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM credentials WHERE name = ? AND expires_at > ?`,
      [name, Date.now()]
    );

    if (rows.length === 0) return null;

    try {
      const { decryptSecret } = await import('../crypto.ts');
      const decryptedSecret = await decryptSecret(rows[0].secret, this.masterEncryptionKey);

      return {
        name: rows[0].name,
        secret: decryptedSecret,
        createdAt: Number(rows[0].created_at),
        expiresAt: Number(rows[0].expires_at),
        lastUsed: Number(rows[0].last_used),
      };
    } catch (error) {
      console.error(`Failed to decrypt secret for credential '${name}':`, error);
      return null;
    }
  }

  async updateCredentialUsage(name: string, lastUsed: number, expiresAt: number): Promise<void> {
    await this.pool.query(
      `UPDATE credentials SET last_used = ?, expires_at = ? WHERE name = ?`,
      [lastUsed, expiresAt, name]
    );
  }

  async deleteExpiredCredentials(now: number): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM credentials WHERE expires_at < ?`,
      [now]
    );
    return result.affectedRows;
  }

  // ===== Rate Limiting =====

  async checkRateLimit(identifier: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const resetTime = now + windowMs;

    // Use INSERT ... ON DUPLICATE KEY UPDATE for atomic upsert
    await this.pool.query(
      `INSERT INTO rate_limits (identifier, count, reset_time)
       VALUES (?, 1, ?)
       ON DUPLICATE KEY UPDATE
         count = IF(reset_time < ?, 1, count + 1),
         reset_time = IF(reset_time < ?, ?, reset_time)`,
      [identifier, resetTime, now, now, resetTime]
    );

    // Get current count
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
      // MySQL duplicate key error code
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

  async getOfferCountByUsername(username: string): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) as count FROM offers WHERE username = ?',
      [username]
    );
    return Number(rows[0].count);
  }

  async getCredentialCount(): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT COUNT(*) as count FROM credentials');
    return Number(rows[0].count);
  }

  async getIceCandidateCount(offerId: string): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) as count FROM ice_candidates WHERE offer_id = ?',
      [offerId]
    );
    return Number(rows[0].count);
  }

  // ===== Helper Methods =====

  private rowToOffer(row: RowDataPacket): Offer {
    return {
      id: row.id,
      username: row.username,
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
      sdp: row.sdp,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      lastSeen: Number(row.last_seen),
      answererUsername: row.answerer_username || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at ? Number(row.answered_at) : undefined,
    };
  }

  private rowToIceCandidate(row: RowDataPacket): IceCandidate {
    return {
      id: Number(row.id),
      offerId: row.offer_id,
      username: row.username,
      role: row.role as 'offerer' | 'answerer',
      candidate: typeof row.candidate === 'string' ? JSON.parse(row.candidate) : row.candidate,
      createdAt: Number(row.created_at),
    };
  }
}
