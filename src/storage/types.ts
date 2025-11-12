/**
 * Represents a WebRTC signaling offer
 */
export interface Offer {
  code: string;
  origin: string;
  peerId: string;
  offer: string;
  answer?: string;
  offerCandidates: string[];
  answerCandidates: string[];
  createdAt: number;
  expiresAt: number;
}

/**
 * Storage interface for offer management
 * Implementations can use different backends (SQLite, D1, Memory, etc.)
 */
export interface Storage {
  /**
   * Creates a new offer
   * @param origin The Origin header from the request
   * @param peerId Peer identifier string (max 1024 chars)
   * @param offer The WebRTC SDP offer message
   * @param expiresAt Unix timestamp when the offer should expire
   * @param customCode Optional custom code (if not provided, generates UUID)
   * @returns The unique offer code
   */
  createOffer(origin: string, peerId: string, offer: string, expiresAt: number, customCode?: string): Promise<string>;

  /**
   * Retrieves an offer by its code
   * @param code The offer code
   * @param origin The Origin header from the request (for validation)
   * @returns The offer if found, null otherwise
   */
  getOffer(code: string, origin: string): Promise<Offer | null>;

  /**
   * Updates an existing offer with new data
   * @param code The offer code
   * @param origin The Origin header from the request (for validation)
   * @param update Partial offer data to update
   */
  updateOffer(code: string, origin: string, update: Partial<Offer>): Promise<void>;

  /**
   * Deletes an offer
   * @param code The offer code
   */
  deleteOffer(code: string): Promise<void>;

  /**
   * Removes expired offers
   * Should be called periodically to clean up old data
   */
  cleanup(): Promise<void>;

  /**
   * Closes the storage connection and releases resources
   */
  close(): Promise<void>;
}
