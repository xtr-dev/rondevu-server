// Use Web Crypto API (available globally in Cloudflare Workers)
import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
  Credential,
  GenerateCredentialsRequest,
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';

const YEAR_IN_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

/**
 * D1 storage adapter for rondevu signaling system using Cloudflare D1
 */
export class D1Storage implements Storage {
  private db: D1Database;
  private masterEncryptionKey: string;

  /**
   * Creates a new D1 storage instance
   * @param db D1Database instance from Cloudflare Workers environment
   * @param masterEncryptionKey 64-char hex string for encrypting secrets (32 bytes)
   */
  constructor(db: D1Database, masterEncryptionKey: string) {
    this.db = db;
    this.masterEncryptionKey = masterEncryptionKey;
  }

  /**
   * Initializes database schema with tags-based offers
   * This should be run once during setup, not on every request
   */
  async initializeDatabase(): Promise<void> {
    await this.db.exec(`
      -- WebRTC signaling offers with tags
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        tags TEXT NOT NULL,
        sdp TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        answerer_username TEXT,
        answer_sdp TEXT,
        answered_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_offers_username ON offers(username);
      CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at);
      CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen);
      CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_username);

      -- ICE candidates table
      CREATE TABLE IF NOT EXISTS ice_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
        candidate TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_username ON ice_candidates(username);
      CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at);

      -- Credentials table (replaces usernames with simpler name + secret auth)
      CREATE TABLE IF NOT EXISTS credentials (
        name TEXT PRIMARY KEY,
        secret TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        CHECK(length(name) >= 3 AND length(name) <= 32)
      );

      CREATE INDEX IF NOT EXISTS idx_credentials_expires ON credentials(expires_at);
      CREATE INDEX IF NOT EXISTS idx_credentials_secret ON credentials(secret);

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
  }

  // ===== Offer Management =====

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    const created: Offer[] = [];

    // D1 doesn't support true transactions yet, so we do this sequentially
    for (const offer of offers) {
      const id = offer.id || await generateOfferHash(offer.sdp);
      const now = Date.now();

      await this.db.prepare(`
        INSERT INTO offers (id, username, tags, sdp, created_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(id, offer.username, JSON.stringify(offer.tags), offer.sdp, now, offer.expiresAt, now).run();

      created.push({
        id,
        username: offer.username,
        tags: offer.tags,
        sdp: offer.sdp,
        createdAt: now,
        expiresAt: offer.expiresAt,
        lastSeen: now,
      });
    }

    return created;
  }

  async getOffersByUsername(username: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE username = ? AND expires_at > ?
      ORDER BY last_seen DESC
    `).bind(username, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
  }

  async getOfferById(offerId: string): Promise<Offer | null> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE id = ? AND expires_at > ?
    `).bind(offerId, Date.now()).first();

    if (!result) {
      return null;
    }

    return this.rowToOffer(result as any);
  }

  async deleteOffer(offerId: string, ownerUsername: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM offers
      WHERE id = ? AND username = ?
    `).bind(offerId, ownerUsername).run();

    return (result.meta.changes || 0) > 0;
  }

  async deleteExpiredOffers(now: number): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM offers WHERE expires_at < ?
    `).bind(now).run();

    return result.meta.changes || 0;
  }

  async answerOffer(
    offerId: string,
    answererUsername: string,
    answerSdp: string
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
    if (offer.answererUsername) {
      return {
        success: false,
        error: 'Offer already answered'
      };
    }

    // Update offer with answer
    const result = await this.db.prepare(`
      UPDATE offers
      SET answerer_username = ?, answer_sdp = ?, answered_at = ?
      WHERE id = ? AND answerer_username IS NULL
    `).bind(answererUsername, answerSdp, Date.now(), offerId).run();

    if ((result.meta.changes || 0) === 0) {
      return {
        success: false,
        error: 'Offer already answered (race condition)'
      };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererUsername: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE username = ? AND answerer_username IS NOT NULL AND expires_at > ?
      ORDER BY answered_at DESC
    `).bind(offererUsername, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
  }

  async getOffersAnsweredBy(answererUsername: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE answerer_username = ? AND expires_at > ?
      ORDER BY answered_at DESC
    `).bind(answererUsername, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
  }

  // ===== Discovery =====

  async discoverOffers(
    tags: string[],
    excludeUsername: string | null,
    limit: number,
    offset: number
  ): Promise<Offer[]> {
    if (tags.length === 0) {
      return [];
    }

    // Build query with JSON tag matching (OR logic)
    // D1/SQLite: Use json_each() to expand tags array and check if any tag matches
    const placeholders = tags.map(() => '?').join(',');

    let query = `
      SELECT DISTINCT o.* FROM offers o, json_each(o.tags) as t
      WHERE t.value IN (${placeholders})
        AND o.expires_at > ?
        AND o.answerer_username IS NULL
    `;

    const params: any[] = [...tags, Date.now()];

    if (excludeUsername) {
      query += ' AND o.username != ?';
      params.push(excludeUsername);
    }

    query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const result = await this.db.prepare(query).bind(...params).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
  }

  async getRandomOffer(
    tags: string[],
    excludeUsername: string | null
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
        AND o.answerer_username IS NULL
    `;

    const params: any[] = [...tags, Date.now()];

    if (excludeUsername) {
      query += ' AND o.username != ?';
      params.push(excludeUsername);
    }

    query += ' ORDER BY RANDOM() LIMIT 1';

    const result = await this.db.prepare(query).bind(...params).first();

    return result ? this.rowToOffer(result as any) : null;
  }

  // ===== ICE Candidate Management =====

  async addIceCandidates(
    offerId: string,
    username: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number> {
    // D1 doesn't have transactions, so insert one by one
    for (let i = 0; i < candidates.length; i++) {
      const timestamp = Date.now() + i;
      await this.db.prepare(`
        INSERT INTO ice_candidates (offer_id, username, role, candidate, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        offerId,
        username,
        role,
        JSON.stringify(candidates[i]),
        timestamp
      ).run();
    }

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

    const result = await this.db.prepare(query).bind(...params).all();

    if (!result.results) {
      return [];
    }

    return result.results.map((row: any) => ({
      id: row.id,
      offerId: row.offer_id,
      username: row.username,
      role: row.role,
      candidate: JSON.parse(row.candidate),
      createdAt: row.created_at,
    }));
  }

  async getIceCandidatesForMultipleOffers(
    offerIds: string[],
    username: string,
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

    const queryResult = await this.db.prepare(query).bind(...params).all();

    if (!queryResult.results) {
      return result;
    }

    // Group candidates by offer_id
    for (const row of queryResult.results as any[]) {
      const candidate: IceCandidate = {
        id: row.id,
        offerId: row.offer_id,
        username: row.username,
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

  // ===== Credential Management =====

  async generateCredentials(request: GenerateCredentialsRequest): Promise<Credential> {
    const now = Date.now();
    const expiresAt = request.expiresAt || (now + YEAR_IN_MS);

    const { generateCredentialName, generateSecret } = await import('../crypto.ts');

    let name: string;

    if (request.name) {
      // User requested specific username - check if available
      const existing = await this.db.prepare(`
        SELECT name FROM credentials WHERE name = ?
      `).bind(request.name).first();

      if (existing) {
        throw new Error('Username already taken');
      }

      name = request.name;
    } else {
      // Generate random name - retry until unique
      let attempts = 0;
      const maxAttempts = 100;

      while (attempts < maxAttempts) {
        name = generateCredentialName();

        const existing = await this.db.prepare(`
          SELECT name FROM credentials WHERE name = ?
        `).bind(name).first();

        if (!existing) {
          break;
        }

        attempts++;
      }

      if (attempts >= maxAttempts) {
        throw new Error(`Failed to generate unique credential name after ${maxAttempts} attempts`);
      }
    }

    const secret = generateSecret();

    // Encrypt secret before storing (AES-256-GCM)
    const { encryptSecret } = await import('../crypto.ts');
    const encryptedSecret = await encryptSecret(secret, this.masterEncryptionKey);

    // Insert credential with encrypted secret
    await this.db.prepare(`
      INSERT INTO credentials (name, secret, created_at, expires_at, last_used)
      VALUES (?, ?, ?, ?, ?)
    `).bind(name!, encryptedSecret, now, expiresAt, now).run();

    // Return plaintext secret to user (only time they'll see it)
    return {
      name: name!,
      secret, // Return plaintext secret, not encrypted
      createdAt: now,
      expiresAt,
      lastUsed: now,
    };
  }

  async getCredential(name: string): Promise<Credential | null> {
    const result = await this.db.prepare(`
      SELECT * FROM credentials
      WHERE name = ? AND expires_at > ?
    `).bind(name, Date.now()).first();

    if (!result) {
      return null;
    }

    const row = result as any;

    // Decrypt secret before returning
    // If decryption fails (e.g., master key rotated), treat as credential not found
    try {
      const { decryptSecret } = await import('../crypto.ts');
      const decryptedSecret = await decryptSecret(row.secret, this.masterEncryptionKey);

      return {
        name: row.name,
        secret: decryptedSecret, // Return decrypted secret
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsed: row.last_used,
      };
    } catch (error) {
      console.error(`Failed to decrypt secret for credential '${name}':`, error);
      return null; // Treat as credential not found (fail-safe behavior)
    }
  }

  async updateCredentialUsage(name: string, lastUsed: number, expiresAt: number): Promise<void> {
    await this.db.prepare(`
      UPDATE credentials
      SET last_used = ?, expires_at = ?
      WHERE name = ?
    `).bind(lastUsed, expiresAt, name).run();
  }

  async deleteExpiredCredentials(now: number): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM credentials WHERE expires_at < ?
    `).bind(now).run();

    return result.meta.changes || 0;
  }

  // ===== Rate Limiting =====

  async checkRateLimit(identifier: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const resetTime = now + windowMs;

    // Atomic UPSERT: Insert or increment count, reset if expired
    // This prevents TOCTOU race conditions by doing check+increment in single operation
    const result = await this.db.prepare(`
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
    `).bind(identifier, resetTime, now, now, resetTime).first() as { count: number } | null;

    // Check if limit exceeded
    return result ? result.count <= limit : false;
  }

  async deleteExpiredRateLimits(now: number): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM rate_limits WHERE reset_time < ?
    `).bind(now).run();

    return result.meta.changes || 0;
  }

  // ===== Nonce Tracking (Replay Protection) =====

  async checkAndMarkNonce(nonceKey: string, expiresAt: number): Promise<boolean> {
    try {
      // Atomic INSERT - if nonce already exists, this will fail with UNIQUE constraint
      // This prevents replay attacks by ensuring each nonce is only used once
      const result = await this.db.prepare(`
        INSERT INTO nonces (nonce_key, expires_at)
        VALUES (?, ?)
      `).bind(nonceKey, expiresAt).run();

      // D1 returns success=true if insert succeeded
      return result.success;
    } catch (error: any) {
      // UNIQUE constraint violation means nonce already used (replay attack)
      if (error?.message?.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw error; // Other errors should propagate
    }
  }

  async deleteExpiredNonces(now: number): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM nonces WHERE expires_at < ?
    `).bind(now).run();

    return result.meta.changes || 0;
  }

  async close(): Promise<void> {
    // D1 doesn't require explicit connection closing
    // Connections are managed by the Cloudflare Workers runtime
  }

  // ===== Count Methods (for resource limits) =====

  async getOfferCount(): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM offers').first() as { count: number } | null;
    return result?.count ?? 0;
  }

  async getOfferCountByUsername(username: string): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM offers WHERE username = ?')
      .bind(username)
      .first() as { count: number } | null;
    return result?.count ?? 0;
  }

  async getCredentialCount(): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM credentials').first() as { count: number } | null;
    return result?.count ?? 0;
  }

  async getIceCandidateCount(offerId: string): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM ice_candidates WHERE offer_id = ?')
      .bind(offerId)
      .first() as { count: number } | null;
    return result?.count ?? 0;
  }

  // ===== Helper Methods =====

  /**
   * Helper method to convert database row to Offer object
   */
  private rowToOffer(row: any): Offer {
    return {
      id: row.id,
      username: row.username,
      tags: JSON.parse(row.tags),
      sdp: row.sdp,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeen: row.last_seen,
      answererUsername: row.answerer_username || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at || undefined,
    };
  }
}
