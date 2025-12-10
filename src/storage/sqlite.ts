import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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
 * SQLite storage adapter for rondevu DNS-like system
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
   * Initializes database schema with username and service-based structure
   */
  private initializeDatabase(): void {
    this.db.exec(`
      -- WebRTC signaling offers
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        service_id TEXT,
        sdp TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        answerer_username TEXT,
        answer_sdp TEXT,
        answered_at INTEGER,
        FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_offers_username ON offers(username);
      CREATE INDEX IF NOT EXISTS idx_offers_service ON offers(service_id);
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
        INSERT INTO offers (id, username, service_id, sdp, created_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const offer of offersWithIds) {
        const now = Date.now();

        // Insert offer
        offerStmt.run(
          offer.id,
          offer.username,
          offer.serviceId || null,
          offer.sdp,
          now,
          offer.expiresAt,
          now
        );

        created.push({
          id: offer.id,
          username: offer.username,
          serviceId: offer.serviceId || undefined,
          serviceFqn: offer.serviceFqn,
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

  async getOffersByUsername(username: string): Promise<Offer[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE username = ? AND expires_at > ?
      ORDER BY last_seen DESC
    `);

    const rows = stmt.all(username, Date.now()) as any[];
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

  async deleteOffer(offerId: string, ownerUsername: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      DELETE FROM offers
      WHERE id = ? AND username = ?
    `);

    const result = stmt.run(offerId, ownerUsername);
    return result.changes > 0;
  }

  async deleteExpiredOffers(now: number): Promise<number> {
    const stmt = this.db.prepare('DELETE FROM offers WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
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
    const stmt = this.db.prepare(`
      UPDATE offers
      SET answerer_username = ?, answer_sdp = ?, answered_at = ?
      WHERE id = ? AND answerer_username IS NULL
    `);

    const result = stmt.run(answererUsername, answerSdp, Date.now(), offerId);

    if (result.changes === 0) {
      return {
        success: false,
        error: 'Offer already answered (race condition)'
      };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererUsername: string): Promise<Offer[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE username = ? AND answerer_username IS NOT NULL AND expires_at > ?
      ORDER BY answered_at DESC
    `);

    const rows = stmt.all(offererUsername, Date.now()) as any[];
    return rows.map(row => this.rowToOffer(row));
  }

  // ===== ICE Candidate Management =====

  async addIceCandidates(
    offerId: string,
    username: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO ice_candidates (offer_id, username, role, candidate, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const baseTimestamp = Date.now();
    const transaction = this.db.transaction((candidates: any[]) => {
      for (let i = 0; i < candidates.length; i++) {
        stmt.run(
          offerId,
          username,
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
      username: row.username,
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
    const stmt = this.db.prepare(`
      INSERT INTO usernames (username, public_key, claimed_at, expires_at, last_used, metadata)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(username) DO UPDATE SET
        expires_at = ?,
        last_used = ?
      WHERE public_key = ?
    `);

    const result = stmt.run(
      request.username,
      request.publicKey,
      now,
      expiresAt,
      now,
      expiresAt,
      now,
      request.publicKey
    );

    if (result.changes === 0) {
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
    const stmt = this.db.prepare(`
      SELECT * FROM usernames
      WHERE username = ? AND expires_at > ?
    `);

    const row = stmt.get(username, Date.now()) as any;

    if (!row) {
      return null;
    }

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

    const stmt = this.db.prepare(`
      UPDATE usernames
      SET last_used = ?, expires_at = ?
      WHERE username = ? AND expires_at > ?
    `);

    const result = stmt.run(now, expiresAt, username, now);
    return result.changes > 0;
  }

  async deleteExpiredUsernames(now: number): Promise<number> {
    const stmt = this.db.prepare('DELETE FROM usernames WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
  }

  // ===== Service Management =====

  async createService(request: CreateServiceRequest): Promise<{
    service: Service;
    offers: Offer[];
  }> {
    const serviceId = randomUUID();
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

    const transaction = this.db.transaction(() => {
      // Delete existing service with same (service_name, version, username) and its related offers (upsert behavior)
      const existingService = this.db.prepare(`
        SELECT id FROM services
        WHERE service_name = ? AND version = ? AND username = ?
      `).get(serviceName, version, username) as any;

      if (existingService) {
        // Delete related offers first (no FK cascade from offers to services)
        this.db.prepare(`
          DELETE FROM offers WHERE service_id = ?
        `).run(existingService.id);

        // Delete the service
        this.db.prepare(`
          DELETE FROM services WHERE id = ?
        `).run(existingService.id);
      }

      // Insert new service with extracted fields
      this.db.prepare(`
        INSERT INTO services (id, service_fqn, service_name, version, username, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        serviceId,
        request.serviceFqn,
        serviceName,
        version,
        username,
        now,
        request.expiresAt
      );

      // Touch username to extend expiry (inline logic)
      const expiresAt = now + YEAR_IN_MS;
      this.db.prepare(`
        UPDATE usernames
        SET last_used = ?, expires_at = ?
        WHERE username = ? AND expires_at > ?
      `).run(now, expiresAt, username, now);
    });

    transaction();

    // Create offers with serviceId (after transaction)
    const offerRequests = request.offers.map(offer => ({
      ...offer,
      serviceId,
    }));
    const offers = await this.createOffers(offerRequests);

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
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE service_id = ? AND expires_at > ?
      ORDER BY created_at ASC
    `);

    const rows = stmt.all(serviceId, Date.now()) as any[];
    return rows.map(row => this.rowToOffer(row));
  }

  async getServiceById(serviceId: string): Promise<Service | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM services
      WHERE id = ? AND expires_at > ?
    `);

    const row = stmt.get(serviceId, Date.now()) as any;

    if (!row) {
      return null;
    }

    return this.rowToService(row);
  }

  async getServiceByFqn(serviceFqn: string): Promise<Service | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM services
      WHERE service_fqn = ? AND expires_at > ?
    `);

    const row = stmt.get(serviceFqn, Date.now()) as any;

    if (!row) {
      return null;
    }

    return this.rowToService(row);
  }

  async discoverServices(
    serviceName: string,
    version: string,
    limit: number,
    offset: number
  ): Promise<Service[]> {
    // Query for unique services with available offers
    // We join with offers and filter for available ones (answerer_username IS NULL)
    const stmt = this.db.prepare(`
      SELECT DISTINCT s.* FROM services s
      INNER JOIN offers o ON o.service_id = s.id
      WHERE s.service_name = ?
        AND s.version = ?
        AND s.expires_at > ?
        AND o.answerer_username IS NULL
        AND o.expires_at > ?
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(serviceName, version, Date.now(), Date.now(), limit, offset) as any[];
    return rows.map(row => this.rowToService(row));
  }

  async getRandomService(serviceName: string, version: string): Promise<Service | null> {
    // Get a random service with an available offer
    const stmt = this.db.prepare(`
      SELECT s.* FROM services s
      INNER JOIN offers o ON o.service_id = s.id
      WHERE s.service_name = ?
        AND s.version = ?
        AND s.expires_at > ?
        AND o.answerer_username IS NULL
        AND o.expires_at > ?
      ORDER BY RANDOM()
      LIMIT 1
    `);

    const row = stmt.get(serviceName, version, Date.now(), Date.now()) as any;

    if (!row) {
      return null;
    }

    return this.rowToService(row);
  }

  async deleteService(serviceId: string, username: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      DELETE FROM services
      WHERE id = ? AND username = ?
    `);

    const result = stmt.run(serviceId, username);
    return result.changes > 0;
  }

  async deleteExpiredServices(now: number): Promise<number> {
    const stmt = this.db.prepare('DELETE FROM services WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ===== Helper Methods =====

  /**
   * Helper method to convert database row to Offer object
   */
  private rowToOffer(row: any): Offer {
    return {
      id: row.id,
      username: row.username,
      serviceId: row.service_id || undefined,
      serviceFqn: row.service_fqn || undefined,
      sdp: row.sdp,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeen: row.last_seen,
      answererUsername: row.answerer_username || undefined,
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
