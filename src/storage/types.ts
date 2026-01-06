/**
 * Represents a WebRTC signaling offer with tags for discovery
 */
export interface Offer {
  id: string;
  publicKey: string;  // Owner's Ed25519 public key
  tags: string[]; // Tags for discovery (match ANY)
  sdp: string;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  answererPublicKey?: string;
  answerSdp?: string;
  answeredAt?: number;
  matchedTags?: string[];  // Tags the answerer searched for to find this offer
}

/**
 * Represents an ICE candidate for WebRTC signaling
 * Stores the complete candidate object as plain JSON (no type enforcement)
 */
export interface IceCandidate {
  id: number;
  offerId: string;
  publicKey: string;  // Sender's Ed25519 public key
  role: 'offerer' | 'answerer';
  candidate: any; // Full candidate object as JSON - don't enforce structure
  createdAt: number;
}

/**
 * Request to create a new offer
 */
export interface CreateOfferRequest {
  id?: string;
  publicKey: string;  // Owner's Ed25519 public key
  tags: string[]; // Tags for discovery
  sdp: string;
  expiresAt: number;
}

/**
 * Storage interface for rondevu signaling system
 * Implementations can use different backends (SQLite, D1, etc.)
 *
 * TRUST BOUNDARY: The storage layer assumes inputs are pre-validated by the RPC layer.
 * This avoids duplication of validation logic across storage backends.
 * The RPC layer is responsible for:
 *  - Validating tags format
 *  - Validating role is 'offerer' or 'answerer'
 *  - Validating all string parameters are non-empty
 *  - Validating timestamps and expirations
 *  - Verifying authentication and authorization
 *
 * Storage implementations may add defensive checks for critical invariants,
 * but should not duplicate all RPC-layer validation.
 */
export interface Storage {
  // ===== Offer Management =====

  /**
   * Creates one or more offers
   * @param offers Array of offer creation requests
   * @returns Array of created offers with IDs
   */
  createOffers(offers: CreateOfferRequest[]): Promise<Offer[]>;

  /**
   * Retrieves all offers from a specific owner
   * @param publicKey Owner's Ed25519 public key
   * @returns Array of offers from the owner
   */
  getOffersByPublicKey(publicKey: string): Promise<Offer[]>;

  /**
   * Retrieves a specific offer by ID
   * @param offerId Offer identifier
   * @returns The offer if found, null otherwise
   */
  getOfferById(offerId: string): Promise<Offer | null>;

  /**
   * Deletes an offer (with ownership verification)
   * @param offerId Offer identifier
   * @param ownerPublicKey Public key of the owner (for verification)
   * @returns true if deleted, false if not found or not owned
   */
  deleteOffer(offerId: string, ownerPublicKey: string): Promise<boolean>;

  /**
   * Deletes all expired offers
   * @param now Current timestamp
   * @returns Number of offers deleted
   */
  deleteExpiredOffers(now: number): Promise<number>;

  /**
   * Answers an offer (locks it to the answerer)
   * @param offerId Offer identifier
   * @param answererPublicKey Answerer's public key
   * @param answerSdp WebRTC answer SDP
   * @param matchedTags Optional tags the answerer searched for to find this offer
   * @param newExpiresAt Optional new expiry time (to reduce TTL after answer for faster cleanup)
   * @returns Success status and optional error message
   */
  answerOffer(offerId: string, answererPublicKey: string, answerSdp: string, matchedTags?: string[], newExpiresAt?: number): Promise<{
    success: boolean;
    error?: string;
  }>;

  /**
   * Retrieves all answered offers for a specific offerer
   * @param offererPublicKey Offerer's public key
   * @returns Array of answered offers
   */
  getAnsweredOffers(offererPublicKey: string): Promise<Offer[]>;

  /**
   * Retrieves all offers answered by a specific user (where they are the answerer)
   * @param answererPublicKey Answerer's public key
   * @returns Array of offers the user has answered
   */
  getOffersAnsweredBy(answererPublicKey: string): Promise<Offer[]>;

  // ===== Discovery =====

  /**
   * Discovers offers by tags with pagination
   * Returns available offers (where answerer_public_key IS NULL) matching ANY of the provided tags
   * @param tags Array of tags to match (OR logic)
   * @param excludePublicKey Optional public key to exclude from results (self-exclusion)
   * @param limit Maximum number of offers to return
   * @param offset Number of offers to skip
   * @returns Array of available offers matching tags
   */
  discoverOffers(
    tags: string[],
    excludePublicKey: string | null,
    limit: number,
    offset: number
  ): Promise<Offer[]>;

  /**
   * Gets a random available offer matching any of the provided tags
   * @param tags Array of tags to match (OR logic)
   * @param excludePublicKey Optional public key to exclude (self-exclusion)
   * @returns Random available offer, or null if none found
   */
  getRandomOffer(
    tags: string[],
    excludePublicKey: string | null
  ): Promise<Offer | null>;

  // ===== ICE Candidate Management =====

  /**
   * Adds ICE candidates for an offer
   * @param offerId Offer identifier
   * @param publicKey Public key posting the candidates
   * @param role Role of the user (offerer or answerer)
   * @param candidates Array of candidate objects (stored as plain JSON)
   * @returns Number of candidates added
   */
  addIceCandidates(
    offerId: string,
    publicKey: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number>;

  /**
   * Retrieves ICE candidates for an offer
   * @param offerId Offer identifier
   * @param targetRole Role to retrieve candidates for (offerer or answerer)
   * @param since Optional timestamp - only return candidates after this time
   * @returns Array of ICE candidates
   */
  getIceCandidates(
    offerId: string,
    targetRole: 'offerer' | 'answerer',
    since?: number
  ): Promise<IceCandidate[]>;

  /**
   * Retrieves ICE candidates for multiple offers (batch operation)
   * @param offerIds Array of offer identifiers
   * @param publicKey Public key requesting the candidates
   * @param since Optional timestamp - only return candidates after this time
   * @returns Map of offer ID to ICE candidates
   */
  getIceCandidatesForMultipleOffers(
    offerIds: string[],
    publicKey: string,
    since?: number
  ): Promise<Map<string, IceCandidate[]>>;

  // ===== Rate Limiting =====

  /**
   * Check and increment rate limit for an identifier
   * @param identifier Unique identifier (e.g., IP address)
   * @param limit Maximum count allowed
   * @param windowMs Time window in milliseconds
   * @returns true if allowed, false if rate limit exceeded
   */
  checkRateLimit(identifier: string, limit: number, windowMs: number): Promise<boolean>;

  /**
   * Deletes all expired rate limit entries
   * @param now Current timestamp
   * @returns Number of entries deleted
   */
  deleteExpiredRateLimits(now: number): Promise<number>;

  // ===== Nonce Tracking (Replay Protection) =====

  /**
   * Check if nonce has been used and mark it as used (atomic operation)
   * @param nonceKey Unique nonce identifier (format: "nonce:{publicKey}:{nonce}")
   * @param expiresAt Timestamp when nonce expires (should be timestamp + timestampMaxAge)
   * @returns true if nonce is new (allowed), false if already used (replay attack)
   */
  checkAndMarkNonce(nonceKey: string, expiresAt: number): Promise<boolean>;

  /**
   * Deletes all expired nonce entries
   * @param now Current timestamp
   * @returns Number of entries deleted
   */
  deleteExpiredNonces(now: number): Promise<number>;

  /**
   * Closes the storage connection and releases resources
   */
  close(): Promise<void>;

  // ===== Count Methods (for resource limits) =====

  /**
   * Gets total number of offers in storage
   * @returns Total offer count
   */
  getOfferCount(): Promise<number>;

  /**
   * Gets number of offers for a specific owner
   * @param publicKey Owner's public key
   * @returns Offer count for owner
   */
  getOfferCountByPublicKey(publicKey: string): Promise<number>;

  /**
   * Gets number of ICE candidates for a specific offer
   * @param offerId Offer identifier
   * @returns ICE candidate count for offer
   */
  getIceCandidateCount(offerId: string): Promise<number>;
}
