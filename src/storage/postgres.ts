import { Pool, QueryResult } from 'pg';
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
 * PostgreSQL storage adapter for rondevu signaling system
 * Uses connection pooling for efficient resource management
 */
export class PostgreSQLStorage implements Storage {
  private pool: Pool;
  private masterEncryptionKey: string;

  private constructor(pool: Pool, masterEncryptionKey: string) {
    this.pool = pool;
    this.masterEncryptionKey = masterEncryptionKey;
  }

  /**
   * Creates a new PostgreSQL storage instance with connection pooling
   * @param connectionString PostgreSQL connection URL
   * @param masterEncryptionKey 64-char hex string for encrypting secrets
   * @param poolSize Maximum number of connections in the pool
   */
  static async create(
    connectionString: string,
    masterEncryptionKey: string,
    poolSize: number = 10
  ): Promise<PostgreSQLStorage> {
    const pool = new Pool({
      connectionString,
      max: poolSize,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    const storage = new PostgreSQLStorage(pool, masterEncryptionKey);
    await storage.initializeDatabase();
    return storage;
  }

  private async initializeDatabase(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS offers (
          id VARCHAR(64) PRIMARY KEY,
          username VARCHAR(32) NOT NULL,
          tags JSONB NOT NULL,
          sdp TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          last_seen BIGINT NOT NULL,
          answerer_username VARCHAR(32),
          answer_sdp TEXT,
          answered_at BIGINT
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_username ON offers(username)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_username)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_tags ON offers USING GIN(tags)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ice_candidates (
          id BIGSERIAL PRIMARY KEY,
          offer_id VARCHAR(64) NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
          username VARCHAR(32) NOT NULL,
          role VARCHAR(8) NOT NULL CHECK (role IN ('offerer', 'answerer')),
          candidate JSONB NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ice_username ON ice_candidates(username)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS credentials (
          name VARCHAR(32) PRIMARY KEY,
          secret VARCHAR(512) NOT NULL UNIQUE,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          last_used BIGINT NOT NULL
        )
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_credentials_expires ON credentials(expires_at)`);

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
          `INSERT INTO offers (id, username, tags, sdp, created_at, expires_at, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return created;
  }

  async getOffersByUsername(username: string): Promise<Offer[]> {
    const result = await this.pool.query(
      `SELECT * FROM offers WHERE username = $1 AND expires_at > $2 ORDER BY last_seen DESC`,
      [username, Date.now()]
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

  async deleteOffer(offerId: string, ownerUsername: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM offers WHERE id = $1 AND username = $2`,
      [offerId, ownerUsername]
    );
    return (result.rowCount ?? 0) > 0;
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

    const result = await this.pool.query(
      `UPDATE offers SET answerer_username = $1, answer_sdp = $2, answered_at = $3
       WHERE id = $4 AND answerer_username IS NULL`,
      [answererUsername, answerSdp, Date.now(), offerId]
    );

    if ((result.rowCount ?? 0) === 0) {
      return { success: false, error: 'Offer already answered (race condition)' };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererUsername: string): Promise<Offer[]> {
    const result = await this.pool.query(
      `SELECT * FROM offers
       WHERE username = $1 AND answerer_username IS NOT NULL AND expires_at > $2
       ORDER BY answered_at DESC`,
      [offererUsername, Date.now()]
    );
    return result.rows.map(row => this.rowToOffer(row));
  }

  async getOffersAnsweredBy(answererUsername: string): Promise<Offer[]> {
    const result = await this.pool.query(
      `SELECT * FROM offers
       WHERE answerer_username = $1 AND expires_at > $2
       ORDER BY answered_at DESC`,
      [answererUsername, Date.now()]
    );
    return result.rows.map(row => this.rowToOffer(row));
  }

  // ===== Discovery =====

  async discoverOffers(
    tags: string[],
    excludeUsername: string | null,
    limit: number,
    offset: number
  ): Promise<Offer[]> {
    if (tags.length === 0) return [];

    // Use PostgreSQL's ?| operator for JSONB array overlap
    let query = `
      SELECT DISTINCT o.* FROM offers o
      WHERE o.tags ?| $1
        AND o.expires_at > $2
        AND o.answerer_username IS NULL
    `;
    const params: any[] = [tags, Date.now()];
    let paramIndex = 3;

    if (excludeUsername) {
      query += ` AND o.username != $${paramIndex}`;
      params.push(excludeUsername);
      paramIndex++;
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.rowToOffer(row));
  }

  async getRandomOffer(
    tags: string[],
    excludeUsername: string | null
  ): Promise<Offer | null> {
    if (tags.length === 0) return null;

    let query = `
      SELECT DISTINCT o.* FROM offers o
      WHERE o.tags ?| $1
        AND o.expires_at > $2
        AND o.answerer_username IS NULL
    `;
    const params: any[] = [tags, Date.now()];
    let paramIndex = 3;

    if (excludeUsername) {
      query += ` AND o.username != $${paramIndex}`;
      params.push(excludeUsername);
    }

    query += ' ORDER BY RANDOM() LIMIT 1';

    const result = await this.pool.query(query, params);
    return result.rows.length > 0 ? this.rowToOffer(result.rows[0]) : null;
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
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (let i = 0; i < candidates.length; i++) {
        await client.query(
          `INSERT INTO ice_candidates (offer_id, username, role, candidate, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [offerId, username, role, JSON.stringify(candidates[i]), baseTimestamp + i]
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
    username: string,
    since?: number
  ): Promise<Map<string, IceCandidate[]>> {
    const resultMap = new Map<string, IceCandidate[]>();

    if (offerIds.length === 0) return resultMap;
    if (offerIds.length > 1000) {
      throw new Error('Too many offer IDs (max 1000)');
    }

    let query = `
      SELECT ic.*, o.username as offer_username
      FROM ice_candidates ic
      INNER JOIN offers o ON o.id = ic.offer_id
      WHERE ic.offer_id = ANY($1)
      AND (
        (o.username = $2 AND ic.role = 'answerer')
        OR (o.answerer_username = $2 AND ic.role = 'offerer')
      )
    `;
    const params: any[] = [offerIds, username];

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

  // ===== Credential Management =====

  async generateCredentials(request: GenerateCredentialsRequest): Promise<Credential> {
    const now = Date.now();
    const expiresAt = request.expiresAt || (now + YEAR_IN_MS);

    const { generateCredentialName, generateSecret, encryptSecret } = await import('../crypto.ts');

    let name: string;

    if (request.name) {
      const existing = await this.pool.query(
        `SELECT name FROM credentials WHERE name = $1`,
        [request.name]
      );

      if (existing.rows.length > 0) {
        throw new Error('Username already taken');
      }

      name = request.name;
    } else {
      let attempts = 0;
      const maxAttempts = 100;

      while (attempts < maxAttempts) {
        name = generateCredentialName();

        const existing = await this.pool.query(
          `SELECT name FROM credentials WHERE name = $1`,
          [name]
        );

        if (existing.rows.length === 0) break;
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
       VALUES ($1, $2, $3, $4, $5)`,
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
    const result = await this.pool.query(
      `SELECT * FROM credentials WHERE name = $1 AND expires_at > $2`,
      [name, Date.now()]
    );

    if (result.rows.length === 0) return null;

    try {
      const { decryptSecret } = await import('../crypto.ts');
      const decryptedSecret = await decryptSecret(result.rows[0].secret, this.masterEncryptionKey);

      return {
        name: result.rows[0].name,
        secret: decryptedSecret,
        createdAt: Number(result.rows[0].created_at),
        expiresAt: Number(result.rows[0].expires_at),
        lastUsed: Number(result.rows[0].last_used),
      };
    } catch (error) {
      console.error(`Failed to decrypt secret for credential '${name}':`, error);
      return null;
    }
  }

  async updateCredentialUsage(name: string, lastUsed: number, expiresAt: number): Promise<void> {
    await this.pool.query(
      `UPDATE credentials SET last_used = $1, expires_at = $2 WHERE name = $3`,
      [lastUsed, expiresAt, name]
    );
  }

  async deleteExpiredCredentials(now: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM credentials WHERE expires_at < $1`,
      [now]
    );
    return result.rowCount ?? 0;
  }

  // ===== Rate Limiting =====

  async checkRateLimit(identifier: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const resetTime = now + windowMs;

    // Use INSERT ... ON CONFLICT for atomic upsert
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
      // PostgreSQL unique violation error code
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

  // ===== Helper Methods =====

  private rowToOffer(row: any): Offer {
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

  private rowToIceCandidate(row: any): IceCandidate {
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
