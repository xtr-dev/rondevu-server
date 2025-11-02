/**
 * Represents a WebRTC signaling session
 */
export interface Session {
  code: string;
  origin: string;
  topic: string;
  info: string;
  offer: string;
  answer?: string;
  offerCandidates: string[];
  answerCandidates: string[];
  createdAt: number;
  expiresAt: number;
}

/**
 * Storage interface for session management
 * Implementations can use different backends (SQLite, Redis, Memory, etc.)
 */
export interface Storage {
  /**
   * Creates a new session with the given offer
   * @param origin The Origin header from the request
   * @param topic The topic to post the offer to
   * @param info User info string (max 1024 chars)
   * @param offer The WebRTC SDP offer message
   * @param expiresAt Unix timestamp when the session should expire
   * @returns The unique session code
   */
  createSession(origin: string, topic: string, info: string, offer: string, expiresAt: number): Promise<string>;

  /**
   * Lists all unanswered sessions for a given origin and topic
   * @param origin The Origin header from the request
   * @param topic The topic to list offers for
   * @returns Array of sessions that haven't been answered yet
   */
  listSessionsByTopic(origin: string, topic: string): Promise<Session[]>;

  /**
   * Lists all topics for a given origin with their session counts
   * @param origin The Origin header from the request
   * @param page Page number (starting from 1)
   * @param limit Number of results per page (max 1000)
   * @returns Object with topics array and pagination metadata
   */
  listTopics(origin: string, page: number, limit: number): Promise<{
    topics: Array<{ topic: string; count: number }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  }>;

  /**
   * Retrieves a session by its code
   * @param code The session code
   * @param origin The Origin header from the request (for validation)
   * @returns The session if found, null otherwise
   */
  getSession(code: string, origin: string): Promise<Session | null>;

  /**
   * Updates an existing session with new data
   * @param code The session code
   * @param origin The Origin header from the request (for validation)
   * @param update Partial session data to update
   */
  updateSession(code: string, origin: string, update: Partial<Session>): Promise<void>;

  /**
   * Deletes a session
   * @param code The session code
   */
  deleteSession(code: string): Promise<void>;

  /**
   * Removes expired sessions
   * Should be called periodically to clean up old data
   */
  cleanup(): Promise<void>;

  /**
   * Closes the storage connection and releases resources
   */
  close(): Promise<void>;
}
