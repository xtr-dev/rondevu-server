import Database from 'better-sqlite3';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
  Credential,
  GenerateCredentialsRequest,
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
  private masterEncryptionKey: string;

  /**
   * Creates a new SQLite storage instance
   * @param path Path to SQLite database file, or ':memory:' for in-memory database
   * @param masterEncryptionKey 64-char hex string for encrypting secrets (32 bytes)
   */
  constructor(path: string = ':memory:', masterEncryptionKey: string) {
    this.db = new Database(path);
    this.masterEncryptionKey = masterEncryptionKey;
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

      -- Services table (new schema with extracted fields for discovery)
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        service_fqn TEXT NOT NULL,
        service_name TEXT NOT NULL,
        version TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (username) REFERENCES credentials(name) ON DELETE CASCADE,
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
    // For each offer, determine if user is offerer or answerer and get opposite role
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

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    // Group candidates by offer_id
    for (const row of rows) {
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

    // Generate unique name and secret
    const { generateCredentialName, generateSecret } = await import('../crypto.ts');

    // Retry until we find a unique name (collision very unlikely with 2^48 space)
    // 100 attempts provides excellent safety margin
    let name: string;
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      name = generateCredentialName();

      // Check if name already exists
      const existing = this.db.prepare(`
        SELECT name FROM credentials WHERE name = ?
      `).get(name);

      if (!existing) {
        break;
      }

      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error(`Failed to generate unique credential name after ${maxAttempts} attempts`);
    }

    const secret = generateSecret();

    // Encrypt secret before storing (AES-256-GCM)
    const { encryptSecret } = await import('../crypto.ts');
    const encryptedSecret = await encryptSecret(secret, this.masterEncryptionKey);

    // Insert credential with encrypted secret
    const stmt = this.db.prepare(`
      INSERT INTO credentials (name, secret, created_at, expires_at, last_used)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(name!, encryptedSecret, now, expiresAt, now);

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
    const stmt = this.db.prepare(`
      SELECT * FROM credentials
      WHERE name = ? AND expires_at > ?
    `);

    const row = stmt.get(name, Date.now()) as any;

    if (!row) {
      return null;
    }

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

  async verifyCredential(name: string, secret: string): Promise<boolean> {
    const credential = await this.getCredential(name);

    if (!credential) {
      return false;
    }

    // Use timing-safe comparison to prevent timing attacks
    // Even though 128-bit secrets make this unlikely, it's defense-in-depth
    const credentialBuffer = Buffer.from(credential.secret, 'utf8');
    const secretBuffer = Buffer.from(secret, 'utf8');

    // Ensure buffers are same length (timingSafeEqual requirement)
    if (credentialBuffer.length !== secretBuffer.length) {
      return false;
    }

    if (!timingSafeEqual(credentialBuffer, secretBuffer)) {
      return false;
    }

    // Extend expiry on successful verification
    const now = Date.now();
    const expiresAt = now + YEAR_IN_MS;

    const stmt = this.db.prepare(`
      UPDATE credentials
      SET last_used = ?, expires_at = ?
      WHERE name = ?
    `);

    stmt.run(now, expiresAt, name);

    return true;
  }

  async updateCredentialUsage(name: string, lastUsed: number, expiresAt: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE credentials
      SET last_used = ?, expires_at = ?
      WHERE name = ?
    `);

    stmt.run(lastUsed, expiresAt, name);
  }

  async deleteExpiredCredentials(now: number): Promise<number> {
    const stmt = this.db.prepare('DELETE FROM credentials WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
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

      // Touch credential to extend expiry (inline logic)
      const expiresAt = now + YEAR_IN_MS;
      this.db.prepare(`
        UPDATE credentials
        SET last_used = ?, expires_at = ?
        WHERE name = ? AND expires_at > ?
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

  async getOffersForMultipleServices(serviceIds: string[]): Promise<Map<string, Offer[]>> {
    const result = new Map<string, Offer[]>();

    // Return empty map if no service IDs provided
    if (serviceIds.length === 0) {
      return result;
    }

    // Validate array contains only strings (defense-in-depth)
    if (!Array.isArray(serviceIds) || !serviceIds.every(id => typeof id === 'string')) {
      throw new Error('Invalid service IDs: must be array of strings');
    }

    // Prevent DoS attacks from extremely large IN clauses
    // Limit aligns with MAX_DISCOVERY_RESULTS (1000) in rpc.ts
    if (serviceIds.length > 1000) {
      throw new Error('Too many service IDs (max 1000)');
    }

    // Build IN clause with proper parameter binding
    const placeholders = serviceIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE service_id IN (${placeholders}) AND expires_at > ?
      ORDER BY created_at ASC
    `);

    const now = Date.now();
    const rows = stmt.all(...serviceIds, now) as any[];

    // Group offers by service_id
    for (const row of rows) {
      const offer = this.rowToOffer(row);
      const serviceId = row.service_id;

      if (!result.has(serviceId)) {
        result.set(serviceId, []);
      }
      result.get(serviceId)!.push(offer);
    }

    return result;
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

  async getRandomService(serviceName: string, version: string): Promise<{ service: Service; offer: Offer } | null> {
    // Get a random service with an available offer (in single query to avoid N+1)
    const stmt = this.db.prepare(`
      SELECT
        s.id as service_id,
        s.service_fqn,
        s.service_name,
        s.version,
        s.username,
        s.created_at as service_created_at,
        s.expires_at as service_expires_at,
        o.id as offer_id,
        o.username as offer_username,
        o.service_id as offer_service_id,
        o.service_fqn as offer_service_fqn,
        o.sdp,
        o.created_at as offer_created_at,
        o.expires_at as offer_expires_at,
        o.last_seen,
        o.answerer_username,
        o.answer_sdp,
        o.answered_at
      FROM services s
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

    const service: Service = {
      id: row.service_id,
      serviceFqn: row.service_fqn,
      serviceName: row.service_name,
      version: row.version,
      username: row.username,
      createdAt: row.service_created_at,
      expiresAt: row.service_expires_at,
    };

    const offer: Offer = {
      id: row.offer_id,
      username: row.offer_username,
      serviceId: row.offer_service_id || undefined,
      serviceFqn: row.offer_service_fqn || undefined,
      sdp: row.sdp,
      createdAt: row.offer_created_at,
      expiresAt: row.offer_expires_at,
      lastSeen: row.last_seen,
      answererUsername: row.answerer_username || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at || undefined,
    };

    return { service, offer };
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
