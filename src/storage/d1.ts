// Use Web Crypto API (available globally in Cloudflare Workers)
import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
  Username,
  ClaimUsernameRequest,
  Service,
  CreateServiceRequest,
  ServiceInfo,
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';

const YEAR_IN_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

/**
 * D1 storage adapter for rondevu DNS-like system using Cloudflare D1
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
   * Initializes database schema with username and service-based structure
   * This should be run once during setup, not on every request
   */
  async initializeDatabase(): Promise<void> {
    await this.db.exec(`
      -- Offers table (no topics)
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        sdp TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        secret TEXT,
        answerer_peer_id TEXT,
        answer_sdp TEXT,
        answered_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_offers_peer ON offers(peer_id);
      CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at);
      CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen);
      CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_peer_id);

      -- ICE candidates table
      CREATE TABLE IF NOT EXISTS ice_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
        candidate TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_peer ON ice_candidates(peer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at);

      -- Usernames table
      CREATE TABLE IF NOT EXISTS usernames (
        username TEXT PRIMARY KEY,
        public_key TEXT NOT NULL UNIQUE,
        claimed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        metadata TEXT,
        CHECK(length(username) >= 3 AND length(username) <= 32)
      );

      CREATE INDEX IF NOT EXISTS idx_usernames_expires ON usernames(expires_at);
      CREATE INDEX IF NOT EXISTS idx_usernames_public_key ON usernames(public_key);

      -- Services table
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        service_fqn TEXT NOT NULL,
        offer_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        is_public INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE,
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE,
        UNIQUE(username, service_fqn)
      );

      CREATE INDEX IF NOT EXISTS idx_services_username ON services(username);
      CREATE INDEX IF NOT EXISTS idx_services_fqn ON services(service_fqn);
      CREATE INDEX IF NOT EXISTS idx_services_expires ON services(expires_at);
      CREATE INDEX IF NOT EXISTS idx_services_offer ON services(offer_id);

      -- Service index table (privacy layer)
      CREATE TABLE IF NOT EXISTS service_index (
        uuid TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        username TEXT NOT NULL,
        service_fqn TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_service_index_username ON service_index(username);
      CREATE INDEX IF NOT EXISTS idx_service_index_expires ON service_index(expires_at);
    `);
  }

  // ===== Offer Management =====

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    const created: Offer[] = [];

    // D1 doesn't support true transactions yet, so we do this sequentially
    for (const offer of offers) {
      const id = offer.id || await generateOfferHash(offer.sdp, []);
      const now = Date.now();

      await this.db.prepare(`
        INSERT INTO offers (id, peer_id, sdp, created_at, expires_at, last_seen, secret)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(id, offer.peerId, offer.sdp, now, offer.expiresAt, now, offer.secret || null).run();

      created.push({
        id,
        peerId: offer.peerId,
        sdp: offer.sdp,
        createdAt: now,
        expiresAt: offer.expiresAt,
        lastSeen: now,
        secret: offer.secret,
      });
    }

    return created;
  }

  async getOffersByPeerId(peerId: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE peer_id = ? AND expires_at > ?
      ORDER BY last_seen DESC
    `).bind(peerId, Date.now()).all();

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

  async deleteOffer(offerId: string, ownerPeerId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM offers
      WHERE id = ? AND peer_id = ?
    `).bind(offerId, ownerPeerId).run();

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
    answererPeerId: string,
    answerSdp: string,
    secret?: string
  ): Promise<{ success: boolean; error?: string }> {
    // Check if offer exists and is not expired
    const offer = await this.getOfferById(offerId);

    if (!offer) {
      return {
        success: false,
        error: 'Offer not found or expired'
      };
    }

    // Verify secret if offer is protected
    if (offer.secret && offer.secret !== secret) {
      return {
        success: false,
        error: 'Invalid or missing secret'
      };
    }

    // Check if offer already has an answerer
    if (offer.answererPeerId) {
      return {
        success: false,
        error: 'Offer already answered'
      };
    }

    // Update offer with answer
    const result = await this.db.prepare(`
      UPDATE offers
      SET answerer_peer_id = ?, answer_sdp = ?, answered_at = ?
      WHERE id = ? AND answerer_peer_id IS NULL
    `).bind(answererPeerId, answerSdp, Date.now(), offerId).run();

    if ((result.meta.changes || 0) === 0) {
      return {
        success: false,
        error: 'Offer already answered (race condition)'
      };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererPeerId: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE peer_id = ? AND answerer_peer_id IS NOT NULL AND expires_at > ?
      ORDER BY answered_at DESC
    `).bind(offererPeerId, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
  }

  // ===== ICE Candidate Management =====

  async addIceCandidates(
    offerId: string,
    peerId: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number> {
    // D1 doesn't have transactions, so insert one by one
    for (let i = 0; i < candidates.length; i++) {
      const timestamp = Date.now() + i;
      await this.db.prepare(`
        INSERT INTO ice_candidates (offer_id, peer_id, role, candidate, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        offerId,
        peerId,
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
      peerId: row.peer_id,
      role: row.role,
      candidate: JSON.parse(row.candidate),
      createdAt: row.created_at,
    }));
  }

  // ===== Username Management =====

  async claimUsername(request: ClaimUsernameRequest): Promise<Username> {
    const now = Date.now();
    const expiresAt = now + YEAR_IN_MS;

    // Try to insert or update
    const result = await this.db.prepare(`
      INSERT INTO usernames (username, public_key, claimed_at, expires_at, last_used, metadata)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(username) DO UPDATE SET
        expires_at = ?,
        last_used = ?
      WHERE public_key = ?
    `).bind(
      request.username,
      request.publicKey,
      now,
      expiresAt,
      now,
      expiresAt,
      now,
      request.publicKey
    ).run();

    if ((result.meta.changes || 0) === 0) {
      throw new Error('Username already claimed by different public key');
    }

    return {
      username: request.username,
      publicKey: request.publicKey,
      claimedAt: now,
      expiresAt,
      lastUsed: now,
    };
  }

  async getUsername(username: string): Promise<Username | null> {
    const result = await this.db.prepare(`
      SELECT * FROM usernames
      WHERE username = ? AND expires_at > ?
    `).bind(username, Date.now()).first();

    if (!result) {
      return null;
    }

    const row = result as any;

    return {
      username: row.username,
      publicKey: row.public_key,
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
      lastUsed: row.last_used,
      metadata: row.metadata || undefined,
    };
  }

  async touchUsername(username: string): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + YEAR_IN_MS;

    const result = await this.db.prepare(`
      UPDATE usernames
      SET last_used = ?, expires_at = ?
      WHERE username = ? AND expires_at > ?
    `).bind(now, expiresAt, username, now).run();

    return (result.meta.changes || 0) > 0;
  }

  async deleteExpiredUsernames(now: number): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM usernames WHERE expires_at < ?
    `).bind(now).run();

    return result.meta.changes || 0;
  }

  // ===== Service Management =====

  async createService(request: CreateServiceRequest): Promise<{
    service: Service;
    indexUuid: string;
  }> {
    const serviceId = crypto.randomUUID();
    const indexUuid = crypto.randomUUID();
    const now = Date.now();

    // Insert service
    await this.db.prepare(`
      INSERT INTO services (id, username, service_fqn, offer_id, created_at, expires_at, is_public, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      serviceId,
      request.username,
      request.serviceFqn,
      request.offerId,
      now,
      request.expiresAt,
      request.isPublic ? 1 : 0,
      request.metadata || null
    ).run();

    // Insert service index
    await this.db.prepare(`
      INSERT INTO service_index (uuid, service_id, username, service_fqn, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      indexUuid,
      serviceId,
      request.username,
      request.serviceFqn,
      now,
      request.expiresAt
    ).run();

    // Touch username to extend expiry
    await this.touchUsername(request.username);

    return {
      service: {
        id: serviceId,
        username: request.username,
        serviceFqn: request.serviceFqn,
        offerId: request.offerId,
        createdAt: now,
        expiresAt: request.expiresAt,
        isPublic: request.isPublic || false,
        metadata: request.metadata,
      },
      indexUuid,
    };
  }

  async getServiceById(serviceId: string): Promise<Service | null> {
    const result = await this.db.prepare(`
      SELECT * FROM services
      WHERE id = ? AND expires_at > ?
    `).bind(serviceId, Date.now()).first();

    if (!result) {
      return null;
    }

    return this.rowToService(result as any);
  }

  async getServiceByUuid(uuid: string): Promise<Service | null> {
    const result = await this.db.prepare(`
      SELECT s.* FROM services s
      INNER JOIN service_index si ON s.id = si.service_id
      WHERE si.uuid = ? AND s.expires_at > ?
    `).bind(uuid, Date.now()).first();

    if (!result) {
      return null;
    }

    return this.rowToService(result as any);
  }

  async listServicesForUsername(username: string): Promise<ServiceInfo[]> {
    const result = await this.db.prepare(`
      SELECT si.uuid, s.is_public, s.service_fqn, s.metadata
      FROM service_index si
      INNER JOIN services s ON si.service_id = s.id
      WHERE si.username = ? AND si.expires_at > ?
      ORDER BY s.created_at DESC
    `).bind(username, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return result.results.map((row: any) => ({
      uuid: row.uuid,
      isPublic: row.is_public === 1,
      serviceFqn: row.is_public === 1 ? row.service_fqn : undefined,
      metadata: row.is_public === 1 ? row.metadata || undefined : undefined,
    }));
  }

  async queryService(username: string, serviceFqn: string): Promise<string | null> {
    const result = await this.db.prepare(`
      SELECT si.uuid FROM service_index si
      INNER JOIN services s ON si.service_id = s.id
      WHERE si.username = ? AND si.service_fqn = ? AND si.expires_at > ?
    `).bind(username, serviceFqn, Date.now()).first();

    return result ? (result as any).uuid : null;
  }

  async deleteService(serviceId: string, username: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM services
      WHERE id = ? AND username = ?
    `).bind(serviceId, username).run();

    return (result.meta.changes || 0) > 0;
  }

  async deleteExpiredServices(now: number): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM services WHERE expires_at < ?
    `).bind(now).run();

    return result.meta.changes || 0;
  }

  async close(): Promise<void> {
    // D1 doesn't require explicit connection closing
    // Connections are managed by the Cloudflare Workers runtime
  }

  // ===== Helper Methods =====

  /**
   * Helper method to convert database row to Offer object
   */
  private rowToOffer(row: any): Offer {
    return {
      id: row.id,
      peerId: row.peer_id,
      sdp: row.sdp,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeen: row.last_seen,
      secret: row.secret || undefined,
      answererPeerId: row.answerer_peer_id || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at || undefined,
    };
  }

  /**
   * Helper method to convert database row to Service object
   */
  private rowToService(row: any): Service {
    return {
      id: row.id,
      username: row.username,
      serviceFqn: row.service_fqn,
      offerId: row.offer_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      isPublic: row.is_public === 1,
      metadata: row.metadata || undefined,
    };
  }
}
