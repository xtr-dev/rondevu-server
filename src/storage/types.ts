/**
 * Represents a WebRTC signaling offer with topic-based discovery
 */
export interface Offer {
  id: string;
  peerId: string;
  sdp: string;
  topics: string[];
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
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
 * Represents a topic with active peer count
 */
export interface TopicInfo {
  topic: string;
  activePeers: number;
}

/**
 * Request to create a new offer
 */
export interface CreateOfferRequest {
  id?: string;
  peerId: string;
  sdp: string;
  topics: string[];
  expiresAt: number;
}

/**
 * Storage interface for offer management with topic-based discovery
 * Implementations can use different backends (SQLite, D1, Memory, etc.)
 */
export interface Storage {
  /**
   * Creates one or more offers
   * @param offers Array of offer creation requests
   * @returns Array of created offers with IDs
   */
  createOffers(offers: CreateOfferRequest[]): Promise<Offer[]>;

  /**
   * Retrieves offers by topic with optional peer ID exclusion
   * @param topic Topic to search for
   * @param excludePeerIds Optional array of peer IDs to exclude
   * @returns Array of offers matching the topic
   */
  getOffersByTopic(topic: string, excludePeerIds?: string[]): Promise<Offer[]>;

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
   * Updates the last_seen timestamp for an offer (heartbeat)
   * @param offerId Offer identifier
   * @param lastSeen New last_seen timestamp
   */
  updateOfferLastSeen(offerId: string, lastSeen: number): Promise<void>;

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
   * @returns Success status and optional error message
   */
  answerOffer(offerId: string, answererPeerId: string, answerSdp: string): Promise<{
    success: boolean;
    error?: string;
  }>;

  /**
   * Retrieves all answered offers for a specific offerer
   * @param offererPeerId Offerer's peer ID
   * @returns Array of answered offers
   */
  getAnsweredOffers(offererPeerId: string): Promise<Offer[]>;

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

  /**
   * Retrieves topics with active peer counts (paginated)
   * @param limit Maximum number of topics to return
   * @param offset Number of topics to skip
   * @returns Object with topics array and total count
   */
  getTopics(limit: number, offset: number): Promise<{
    topics: TopicInfo[];
    total: number;
  }>;

  /**
   * Closes the storage connection and releases resources
   */
  close(): Promise<void>;
}
