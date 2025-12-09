/**
 * Represents a WebRTC signaling offer
 */
export interface Offer {
  id: string;
  peerId: string;
  serviceId?: string; // Optional link to service (null for standalone offers)
  sdp: string;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  secret?: string;
  answererPeerId?: string;
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
  peerId: string;
  role: 'offerer' | 'answerer';
  candidate: any; // Full candidate object as JSON - don't enforce structure
  createdAt: number;
}

/**
 * Request to create a new offer
 */
export interface CreateOfferRequest {
  id?: string;
  peerId: string;
  serviceId?: string; // Optional link to service
  sdp: string;
  expiresAt: number;
  secret?: string;
}

/**
 * Represents a claimed username with cryptographic proof
 */
export interface Username {
  username: string;
  publicKey: string; // Base64-encoded Ed25519 public key
  claimedAt: number;
  expiresAt: number; // 365 days from claim/last use
  lastUsed: number;
  metadata?: string; // JSON optional user metadata
}

/**
 * Request to claim a username
 */
export interface ClaimUsernameRequest {
  username: string;
  publicKey: string;
  signature: string;
  message: string; // "claim:{username}:{timestamp}"
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
   * Retrieves all offers from a specific peer
   * @param peerId Peer identifier
   * @returns Array of offers from the peer
   */
  getOffersByPeerId(peerId: string): Promise<Offer[]>;

  /**
   * Retrieves a specific offer by ID
   * @param offerId Offer identifier
   * @returns The offer if found, null otherwise
   */
  getOfferById(offerId: string): Promise<Offer | null>;

  /**
   * Deletes an offer (with ownership verification)
   * @param offerId Offer identifier
   * @param ownerPeerId Peer ID of the owner (for verification)
   * @returns true if deleted, false if not found or not owned
   */
  deleteOffer(offerId: string, ownerPeerId: string): Promise<boolean>;

  /**
   * Deletes all expired offers
   * @param now Current timestamp
   * @returns Number of offers deleted
   */
  deleteExpiredOffers(now: number): Promise<number>;

  /**
   * Answers an offer (locks it to the answerer)
   * @param offerId Offer identifier
   * @param answererPeerId Answerer's peer ID
   * @param answerSdp WebRTC answer SDP
   * @param secret Optional secret for protected offers
   * @returns Success status and optional error message
   */
  answerOffer(offerId: string, answererPeerId: string, answerSdp: string, secret?: string): Promise<{
    success: boolean;
    error?: string;
  }>;

  /**
   * Retrieves all answered offers for a specific offerer
   * @param offererPeerId Offerer's peer ID
   * @returns Array of answered offers
   */
  getAnsweredOffers(offererPeerId: string): Promise<Offer[]>;

  // ===== ICE Candidate Management =====

  /**
   * Adds ICE candidates for an offer
   * @param offerId Offer identifier
   * @param peerId Peer ID posting the candidates
   * @param role Role of the peer (offerer or answerer)
   * @param candidates Array of candidate objects (stored as plain JSON)
   * @returns Number of candidates added
   */
  addIceCandidates(
    offerId: string,
    peerId: string,
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

  // ===== Username Management =====

  /**
   * Claims a username (or refreshes expiry if already owned)
   * @param request Username claim request with signature
   * @returns Created/updated username record
   */
  claimUsername(request: ClaimUsernameRequest): Promise<Username>;

  /**
   * Gets a username record
   * @param username Username to look up
   * @returns Username record if claimed, null otherwise
   */
  getUsername(username: string): Promise<Username | null>;

  /**
   * Deletes all expired usernames
   * @param now Current timestamp
   * @returns Number of usernames deleted
   */
  deleteExpiredUsernames(now: number): Promise<number>;

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
