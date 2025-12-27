/**
 * Custom error types for storage layer operations
 * Provides type-safe error handling across different storage backends
 */
export enum StorageErrorCode {
  USERNAME_CONFLICT = 'USERNAME_CONFLICT', // Username already claimed by different key
  PUBLIC_KEY_CONFLICT = 'PUBLIC_KEY_CONFLICT', // Public key already claimed different username
  CONSTRAINT_VIOLATION = 'CONSTRAINT_VIOLATION', // Generic constraint violation
}

/**
 * Custom error class for storage layer
 * Allows RPC layer to handle errors without relying on string matching
 */
export class StorageError extends Error {
  constructor(
    public code: StorageErrorCode,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Represents a WebRTC signaling offer
 */
export interface Offer {
  id: string;
  username: string;
  serviceId?: string; // Optional link to service (null for standalone offers)
  serviceFqn?: string; // Denormalized service FQN for easier queries
  sdp: string;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  answererUsername?: string;
  answerSdp?: string;
  answeredAt?: number;
}

/**
 * Represents an ICE candidate for WebRTC signaling
 * Stores the complete candidate object as plain JSON (no type enforcement)
 */
export interface IceCandidate {
  id: number;
  offerId: string;
  username: string;
  role: 'offerer' | 'answerer';
  candidate: any; // Full candidate object as JSON - don't enforce structure
  createdAt: number;
}

/**
 * Request to create a new offer
 */
export interface CreateOfferRequest {
  id?: string;
  username: string;
  serviceId?: string; // Optional link to service
  serviceFqn?: string; // Optional service FQN
  sdp: string;
  expiresAt: number;
}

/**
 * Represents a credential (random name + secret pair)
 * Replaces the old username/publicKey system for simpler authentication
 */
export interface Credential {
  name: string; // Random name (e.g., "brave-tiger-7a3f")
  secret: string; // Random secret (API key style)
  createdAt: number;
  expiresAt: number; // 365 days from creation/last use
  lastUsed: number;
}

/**
 * Request to generate new credentials
 */
export interface GenerateCredentialsRequest {
  expiresAt?: number; // Optional: override default expiry
}

/**
 * Represents a published service (can have multiple offers)
 * New format: service:version@username (e.g., chat:1.0.0@alice)
 */
export interface Service {
  id: string; // UUID v4
  serviceFqn: string; // Full FQN: chat:1.0.0@alice
  serviceName: string; // Extracted: chat
  version: string; // Extracted: 1.0.0
  username: string; // Extracted: alice
  createdAt: number;
  expiresAt: number;
}

/**
 * Request to create a single service
 */
export interface CreateServiceRequest {
  serviceFqn: string; // Full FQN with username: chat:1.0.0@alice
  expiresAt: number;
  offers: CreateOfferRequest[]; // Multiple offers per service
}

/**
 * Storage interface for rondevu DNS-like system
 * Implementations can use different backends (SQLite, D1, etc.)
 *
 * TRUST BOUNDARY: The storage layer assumes inputs are pre-validated by the RPC layer.
 * This avoids duplication of validation logic across storage backends.
 * The RPC layer is responsible for:
 *  - Validating serviceFqn format and ownership
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
   * Retrieves all offers from a specific user
   * @param username Username identifier
   * @returns Array of offers from the user
   */
  getOffersByUsername(username: string): Promise<Offer[]>;

  /**
   * Retrieves a specific offer by ID
   * @param offerId Offer identifier
   * @returns The offer if found, null otherwise
   */
  getOfferById(offerId: string): Promise<Offer | null>;

  /**
   * Deletes an offer (with ownership verification)
   * @param offerId Offer identifier
   * @param ownerUsername Username of the owner (for verification)
   * @returns true if deleted, false if not found or not owned
   */
  deleteOffer(offerId: string, ownerUsername: string): Promise<boolean>;

  /**
   * Deletes all expired offers
   * @param now Current timestamp
   * @returns Number of offers deleted
   */
  deleteExpiredOffers(now: number): Promise<number>;

  /**
   * Answers an offer (locks it to the answerer)
   * @param offerId Offer identifier
   * @param answererUsername Answerer's username
   * @param answerSdp WebRTC answer SDP
   * @returns Success status and optional error message
   */
  answerOffer(offerId: string, answererUsername: string, answerSdp: string): Promise<{
    success: boolean;
    error?: string;
  }>;

  /**
   * Retrieves all answered offers for a specific offerer
   * @param offererUsername Offerer's username
   * @returns Array of answered offers
   */
  getAnsweredOffers(offererUsername: string): Promise<Offer[]>;

  // ===== ICE Candidate Management =====

  /**
   * Adds ICE candidates for an offer
   * @param offerId Offer identifier
   * @param username Username posting the candidates
   * @param role Role of the user (offerer or answerer)
   * @param candidates Array of candidate objects (stored as plain JSON)
   * @returns Number of candidates added
   */
  addIceCandidates(
    offerId: string,
    username: string,
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
   * @param username Username requesting the candidates
   * @param since Optional timestamp - only return candidates after this time
   * @returns Map of offer ID to ICE candidates
   */
  getIceCandidatesForMultipleOffers(
    offerIds: string[],
    username: string,
    since?: number
  ): Promise<Map<string, IceCandidate[]>>;

  // ===== Credential Management =====

  /**
   * Generates a new credential (random name + secret)
   * @param request Credential generation request
   * @returns Created credential record
   */
  generateCredentials(request: GenerateCredentialsRequest): Promise<Credential>;

  /**
   * Gets a credential by name
   * @param name Credential name
   * @returns Credential record if found, null otherwise
   */
  getCredential(name: string): Promise<Credential | null>;

  /**
   * Verifies a credential (checks secret and extends expiry if valid)
   * @param name Credential name
   * @param secret Secret to verify
   * @returns true if valid, false otherwise
   */
  verifyCredential(name: string, secret: string): Promise<boolean>;

  /**
   * Deletes all expired credentials
   * @param now Current timestamp
   * @returns Number of credentials deleted
   */
  deleteExpiredCredentials(now: number): Promise<number>;

  // ===== Service Management =====

  /**
   * Creates a new service with offers
   * @param request Service creation request (includes offers)
   * @returns Created service with generated ID and created offers
   */
  createService(request: CreateServiceRequest): Promise<{
    service: Service;
    offers: Offer[];
  }>;


  /**
   * Gets all offers for a service
   * @param serviceId Service ID
   * @returns Array of offers for the service
   */
  getOffersForService(serviceId: string): Promise<Offer[]>;

  /**
   * Gets all offers for multiple services (batch operation)
   * @param serviceIds Array of service IDs
   * @returns Map of service ID to offers array
   */
  getOffersForMultipleServices(serviceIds: string[]): Promise<Map<string, Offer[]>>;

  /**
   * Gets a service by its service ID
   * @param serviceId Service ID
   * @returns Service if found, null otherwise
   */
  getServiceById(serviceId: string): Promise<Service | null>;

  /**
   * Gets a service by its fully qualified name (FQN)
   * @param serviceFqn Full service FQN (e.g., "chat:1.0.0@alice")
   * @returns Service if found, null otherwise
   */
  getServiceByFqn(serviceFqn: string): Promise<Service | null>;





  /**
   * Discovers services by name and version with pagination
   * Returns unique available offers (where answerer_peer_id IS NULL)
   * @param serviceName Service name (e.g., 'chat')
   * @param version Version string for semver matching (e.g., '1.0.0')
   * @param limit Maximum number of unique services to return
   * @param offset Number of services to skip
   * @returns Array of services with available offers
   */
  discoverServices(
    serviceName: string,
    version: string,
    limit: number,
    offset: number
  ): Promise<Service[]>;

  /**
   * Gets a random available service by name and version
   * Returns a single random offer that is available (answerer_peer_id IS NULL)
   * @param serviceName Service name (e.g., 'chat')
   * @param version Version string for semver matching (e.g., '1.0.0')
   * @returns Random service with available offer, or null if none found
   */
  getRandomService(serviceName: string, version: string): Promise<Service | null>;

  /**
   * Deletes a service (with ownership verification)
   * @param serviceId Service ID
   * @param username Owner username (for verification)
   * @returns true if deleted, false if not found or not owned
   */
  deleteService(serviceId: string, username: string): Promise<boolean>;

  /**
   * Deletes all expired services
   * @param now Current timestamp
   * @returns Number of services deleted
   */
  deleteExpiredServices(now: number): Promise<number>;

  /**
   * Closes the storage connection and releases resources
   */
  close(): Promise<void>;
}
