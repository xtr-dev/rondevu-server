import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';

/**
 * D1 storage adapter for rondevu signaling system using Cloudflare D1
 * Uses Ed25519 public key as identity (no usernames, no secrets)
 */
export class D1Storage implements Storage {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Initializes database schema for Ed25519 public key identity system
   * This should be run once during setup, not on every request
   */
  async initializeDatabase(): Promise<void> {
    await this.db.exec(`
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
      -- Note: No foreign key to identities - auth is stateless (signature-based)
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
        matched_tags TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_offers_public_key ON offers(public_key);
      CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at);
      CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen);
      CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_public_key);

      -- ICE candidates table
      -- Note: No foreign key - offers may be deleted before candidates are read
      CREATE TABLE IF NOT EXISTS ice_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
        candidate TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_public_key ON ice_candidates(public_key);
      CREATE INDEX IF NOT EXISTS idx_ice_role ON ice_candidates(role);
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
  }

  // ===== Offer Management =====

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    const created: Offer[] = [];

    for (const offer of offers) {
      const id = offer.id || await generateOfferHash(offer.sdp);
      const now = Date.now();

      await this.db.prepare(`
        INSERT INTO offers (id, public_key, tags, sdp, created_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(id, offer.publicKey, JSON.stringify(offer.tags), offer.sdp, now, offer.expiresAt, now).run();

      created.push({
        id,
        publicKey: offer.publicKey,
        tags: offer.tags,
        sdp: offer.sdp,
        createdAt: now,
        expiresAt: offer.expiresAt,
        lastSeen: now,
      });
    }

    return created;
  }

  async getOffersByPublicKey(publicKey: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE public_key = ? AND expires_at > ?
      ORDER BY last_seen DESC
    `).bind(publicKey, Date.now()).all();

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

  async deleteOffer(offerId: string, ownerPublicKey: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM offers
      WHERE id = ? AND public_key = ?
    `).bind(offerId, ownerPublicKey).run();

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

    const result = await this.db.prepare(query).bind(...params).run();

    if ((result.meta.changes || 0) === 0) {
      return { success: false, error: 'Offer already answered (race condition)' };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererPublicKey: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE public_key = ? AND answerer_public_key IS NOT NULL AND expires_at > ?
      ORDER BY answered_at DESC
    `).bind(offererPublicKey, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
  }

  async getOffersAnsweredBy(answererPublicKey: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE answerer_public_key = ? AND expires_at > ?
      ORDER BY answered_at DESC
    `).bind(answererPublicKey, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
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

    const result = await this.db.prepare(query).bind(...params).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
  }

  async getRandomOffer(
    tags: string[],
    excludePublicKey: string | null
  ): Promise<Offer | null> {
    if (tags.length === 0) {
      return null;
    }

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

    const result = await this.db.prepare(query).bind(...params).first();

    return result ? this.rowToOffer(result as any) : null;
  }

  // ===== ICE Candidate Management =====

  async addIceCandidates(
    offerId: string,
    publicKey: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number> {
    for (let i = 0; i < candidates.length; i++) {
      const timestamp = Date.now() + i;
      await this.db.prepare(`
        INSERT INTO ice_candidates (offer_id, public_key, role, candidate, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        offerId,
        publicKey,
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

    if (offerIds.length === 0) {
      return result;
    }

    if (!Array.isArray(offerIds) || !offerIds.every(id => typeof id === 'string')) {
      throw new Error('Invalid offer IDs: must be array of strings');
    }

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

    const queryResult = await this.db.prepare(query).bind(...params).all();

    if (!queryResult.results) {
      return result;
    }

    for (const row of queryResult.results as any[]) {
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
      const result = await this.db.prepare(`
        INSERT INTO nonces (nonce_key, expires_at)
        VALUES (?, ?)
      `).bind(nonceKey, expiresAt).run();

      return result.success;
    } catch (error: any) {
      if (error?.message?.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw error;
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
  }

  // ===== Count Methods (for resource limits) =====

  async getOfferCount(): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM offers').first() as { count: number } | null;
    return result?.count ?? 0;
  }

  async getOfferCountByPublicKey(publicKey: string): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM offers WHERE public_key = ?')
      .bind(publicKey)
      .first() as { count: number } | null;
    return result?.count ?? 0;
  }

  async getIceCandidateCount(offerId: string): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM ice_candidates WHERE offer_id = ?')
      .bind(offerId)
      .first() as { count: number } | null;
    return result?.count ?? 0;
  }

  // ===== Helper Methods =====

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
