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
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';
import { parseServiceFqn } from '../crypto.ts';

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
      -- WebRTC signaling offers
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        service_id TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_offers_service ON offers(service_id);
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

      -- Services table (new schema with extracted fields for discovery)
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        service_fqn TEXT NOT NULL,
        service_name TEXT NOT NULL,
        version TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE,
        UNIQUE(service_fqn)
      );

      CREATE INDEX IF NOT EXISTS idx_services_fqn ON services(service_fqn);
      CREATE INDEX IF NOT EXISTS idx_services_discovery ON services(service_name, version);
      CREATE INDEX IF NOT EXISTS idx_services_username ON services(username);
      CREATE INDEX IF NOT EXISTS idx_services_expires ON services(expires_at);
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
        INSERT INTO offers (id, peer_id, service_id, sdp, created_at, expires_at, last_seen, secret)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, offer.peerId, offer.serviceId || null, offer.sdp, now, offer.expiresAt, now, offer.secret || null).run();

      created.push({
        id,
        peerId: offer.peerId,
        serviceId: offer.serviceId,
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

    try {
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
    } catch (err: any) {
      // Handle UNIQUE constraint on public_key
      if (err.message?.includes('UNIQUE constraint failed: usernames.public_key')) {
        throw new Error('This public key has already claimed a different username');
      }
      throw err;
    }
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


  async deleteExpiredUsernames(now: number): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM usernames WHERE expires_at < ?
    `).bind(now).run();

    return result.meta.changes || 0;
  }

  // ===== Service Management =====

  async createService(request: CreateServiceRequest): Promise<{
    service: Service;
    offers: Offer[];
  }> {
    const serviceId = crypto.randomUUID();
    const now = Date.now();

    // Parse FQN to extract components
    const parsed = parseServiceFqn(request.serviceFqn);
    if (!parsed) {
      throw new Error(`Invalid service FQN: ${request.serviceFqn}`);
    }
    if (!parsed.username) {
      throw new Error(`Service FQN must include username: ${request.serviceFqn}`);
    }

    const { serviceName, version, username } = parsed;

    // Insert service with extracted fields
    await this.db.prepare(`
      INSERT INTO services (id, service_fqn, service_name, version, username, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      serviceId,
      request.serviceFqn,
      serviceName,
      version,
      username,
      now,
      request.expiresAt
    ).run();

    // Create offers with serviceId
    const offerRequests = request.offers.map(offer => ({
      ...offer,
      serviceId,
    }));
    const offers = await this.createOffers(offerRequests);

    // Touch username to extend expiry (inline logic)
    const expiresAt = now + YEAR_IN_MS;
    await this.db.prepare(`
      UPDATE usernames
      SET last_used = ?, expires_at = ?
      WHERE username = ? AND expires_at > ?
    `).bind(now, expiresAt, username, now).run();

    return {
      service: {
        id: serviceId,
        serviceFqn: request.serviceFqn,
        serviceName,
        version,
        username,
        createdAt: now,
        expiresAt: request.expiresAt,
      },
      offers,
    };
  }


  async getOffersForService(serviceId: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE service_id = ? AND expires_at > ?
      ORDER BY created_at ASC
    `).bind(serviceId, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToOffer(row as any));
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

  async getServiceByFqn(serviceFqn: string): Promise<Service | null> {
    const result = await this.db.prepare(`
      SELECT * FROM services
      WHERE service_fqn = ? AND expires_at > ?
    `).bind(serviceFqn, Date.now()).first();

    if (!result) {
      return null;
    }

    return this.rowToService(result as any);
  }





  async discoverServices(
    serviceName: string,
    version: string,
    limit: number,
    offset: number
  ): Promise<Service[]> {
    // Query for unique services with available offers
    // We join with offers and filter for available ones (answerer_peer_id IS NULL)
    const result = await this.db.prepare(`
      SELECT DISTINCT s.* FROM services s
      INNER JOIN offers o ON o.service_id = s.id
      WHERE s.service_name = ?
        AND s.version = ?
        AND s.expires_at > ?
        AND o.answerer_peer_id IS NULL
        AND o.expires_at > ?
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(serviceName, version, Date.now(), Date.now(), limit, offset).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToService(row as any));
  }

  async getRandomService(serviceName: string, version: string): Promise<Service | null> {
    // Get a random service with an available offer
    const result = await this.db.prepare(`
      SELECT s.* FROM services s
      INNER JOIN offers o ON o.service_id = s.id
      WHERE s.service_name = ?
        AND s.version = ?
        AND s.expires_at > ?
        AND o.answerer_peer_id IS NULL
        AND o.expires_at > ?
      ORDER BY RANDOM()
      LIMIT 1
    `).bind(serviceName, version, Date.now(), Date.now()).first();

    if (!result) {
      return null;
    }

    return this.rowToService(result as any);
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
      serviceId: row.service_id || undefined,
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
      serviceFqn: row.service_fqn,
      serviceName: row.service_name,
      version: row.version,
      username: row.username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
}
