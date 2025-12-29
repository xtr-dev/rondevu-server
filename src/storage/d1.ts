// Use Web Crypto API (available globally in Cloudflare Workers)
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
 * Timing-safe string comparison for Cloudflare Workers
 * Uses constant-time comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * D1 storage adapter for rondevu DNS-like system using Cloudflare D1
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
   * Initializes database schema with username and service-based structure
   * This should be run once during setup, not on every request
   */
  async initializeDatabase(): Promise<void> {
    await this.db.exec(`
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
        answered_at INTEGER
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
  }

  // ===== Offer Management =====

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    const created: Offer[] = [];

    // D1 doesn't support true transactions yet, so we do this sequentially
    for (const offer of offers) {
      const id = offer.id || await generateOfferHash(offer.sdp);
      const now = Date.now();

      await this.db.prepare(`
        INSERT INTO offers (id, username, service_id, sdp, created_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(id, offer.username, offer.serviceId || null, offer.sdp, now, offer.expiresAt, now).run();

      created.push({
        id,
        username: offer.username,
        serviceId: offer.serviceId,
        serviceFqn: offer.serviceFqn,
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

  // ===== Username Management =====

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

  async verifyCredential(name: string, secret: string): Promise<boolean> {
    const credential = await this.getCredential(name);

    if (!credential) {
      return false;
    }

    // Use timing-safe comparison to prevent timing attacks
    // Even though 128-bit secrets make this unlikely, it's defense-in-depth
    if (!timingSafeEqual(credential.secret, secret)) {
      return false;
    }

    // Extend expiry on successful verification
    const now = Date.now();
    const expiresAt = now + YEAR_IN_MS;

    await this.db.prepare(`
      UPDATE credentials
      SET last_used = ?, expires_at = ?
      WHERE name = ?
    `).bind(now, expiresAt, name).run();

    return true;
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

    // Delete existing service with same (service_name, version, username) and its related offers (upsert behavior)
    // First get the existing service
    const existingService = await this.db.prepare(`
      SELECT id FROM services
      WHERE service_name = ? AND version = ? AND username = ?
    `).bind(serviceName, version, username).first();

    // Use batch() for atomic execution of service creation and username touch
    // This ensures consistency - either all succeed or all fail
    const statements = [];

    if (existingService) {
      // Delete related offers first (no FK cascade from offers to services)
      statements.push(
        this.db.prepare(`DELETE FROM offers WHERE service_id = ?`).bind(existingService.id)
      );

      // Delete the service
      statements.push(
        this.db.prepare(`DELETE FROM services WHERE id = ?`).bind(existingService.id)
      );
    }

    // Insert new service with extracted fields
    statements.push(
      this.db.prepare(`
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
      )
    );

    // Touch credential to extend expiry (inline logic)
    const expiresAt = now + YEAR_IN_MS;
    statements.push(
      this.db.prepare(`
        UPDATE credentials
        SET last_used = ?, expires_at = ?
        WHERE name = ? AND expires_at > ?
      `).bind(now, expiresAt, username, now)
    );

    // Execute all statements atomically
    await this.db.batch(statements);

    // Create offers with serviceId (after atomic transaction)
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

  async getOffersForMultipleServices(serviceIds: string[]): Promise<Map<string, Offer[]>> {
    const resultMap = new Map<string, Offer[]>();

    // Return empty map if no service IDs provided
    if (serviceIds.length === 0) {
      return resultMap;
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
    const query = `
      SELECT * FROM offers
      WHERE service_id IN (${placeholders}) AND expires_at > ?
      ORDER BY created_at ASC
    `;

    // D1 requires binding each parameter individually
    let preparedQuery = this.db.prepare(query);
    for (const serviceId of serviceIds) {
      preparedQuery = preparedQuery.bind(serviceId);
    }
    preparedQuery = preparedQuery.bind(Date.now());

    const result = await preparedQuery.all();

    if (!result.results) {
      return resultMap;
    }

    // Group offers by service_id
    for (const row of result.results) {
      const offer = this.rowToOffer(row as any);
      const serviceId = (row as any).service_id;

      if (!resultMap.has(serviceId)) {
        resultMap.set(serviceId, []);
      }
      resultMap.get(serviceId)!.push(offer);
    }

    return resultMap;
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
    // We join with offers and filter for available ones (answerer_username IS NULL)
    const result = await this.db.prepare(`
      SELECT DISTINCT s.* FROM services s
      INNER JOIN offers o ON o.service_id = s.id
      WHERE s.service_name = ?
        AND s.version = ?
        AND s.expires_at > ?
        AND o.answerer_username IS NULL
        AND o.expires_at > ?
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(serviceName, version, Date.now(), Date.now(), limit, offset).all();

    if (!result.results) {
      return [];
    }

    return result.results.map(row => this.rowToService(row as any));
  }

  async getRandomService(serviceName: string, version: string): Promise<{ service: Service; offer: Offer } | null> {
    // Get a random service with an available offer (in single query to avoid N+1)
    const result = await this.db.prepare(`
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
    `).bind(serviceName, version, Date.now(), Date.now()).first();

    if (!result) {
      return null;
    }

    const row = result as any;

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
