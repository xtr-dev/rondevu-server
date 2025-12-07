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
 */
export interface Service {
  id: string; // UUID v4
  username: string;
  serviceFqn: string; // com.example.chat@1.0.0
  createdAt: number;
  expiresAt: number;
  isPublic: boolean;
  metadata?: string; // JSON service description
}

/**
 * Request to create a single service
 */
export interface CreateServiceRequest {
  username: string;
  serviceFqn: string;
  expiresAt: number;
  isPublic?: boolean;
  metadata?: string;
  offers: CreateOfferRequest[]; // Multiple offers per service
}

/**
 * Request to create multiple services in batch
 */
export interface BatchCreateServicesRequest {
  services: CreateServiceRequest[];
}

/**
 * Represents a service index entry (privacy layer)
 */
export interface ServiceIndex {
  uuid: string; // Random UUID for privacy
  serviceId: string;
  username: string;
  serviceFqn: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Service info for discovery (privacy-aware)
 */
export interface ServiceInfo {
  uuid: string;
  isPublic: boolean;
  serviceFqn?: string; // Only present if public
  metadata?: string; // Only present if public
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
   * Updates the last_used timestamp for a username (extends expiry)
   * @param username Username to update
   * @returns true if updated, false if not found
   */
  touchUsername(username: string): Promise<boolean>;

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
   * @returns Created service with generated ID, index UUID, and created offers
   */
  createService(request: CreateServiceRequest): Promise<{
    service: Service;
    indexUuid: string;
    offers: Offer[];
  }>;

  /**
   * Creates multiple services with offers in batch
   * @param requests Array of service creation requests
   * @returns Array of created services with IDs, UUIDs, and offers
   */
  batchCreateServices(requests: CreateServiceRequest[]): Promise<Array<{
    service: Service;
    indexUuid: string;
    offers: Offer[];
  }>>;

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
   * Gets a service by its index UUID
   * @param uuid Index UUID
   * @returns Service if found, null otherwise
   */
  getServiceByUuid(uuid: string): Promise<Service | null>;

  /**
   * Lists all services for a username (with privacy filtering)
   * @param username Username to query
   * @returns Array of service info (UUIDs only for private services)
   */
  listServicesForUsername(username: string): Promise<ServiceInfo[]>;

  /**
   * Queries a service by username and FQN
   * @param username Username
   * @param serviceFqn Service FQN
   * @returns Service index UUID if found, null otherwise
   */
  queryService(username: string, serviceFqn: string): Promise<string | null>;

  /**
   * Finds all services by username and service name (without version)
   * @param username Username
   * @param serviceName Service name (e.g., 'com.example.chat')
   * @returns Array of services with matching service name
   */
  findServicesByName(username: string, serviceName: string): Promise<Service[]>;

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
