import { Storage, Session } from './types.ts';

/**
 * Cloudflare KV storage adapter for session management
 */
export class KVStorage implements Storage {
  private kv: KVNamespace;

  /**
   * Creates a new KV storage instance
   * @param kv Cloudflare KV namespace binding
   */
  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  /**
   * Generates a unique code using Web Crypto API
   */
  private generateCode(): string {
    return crypto.randomUUID();
  }

  /**
   * Gets the key for storing a session
   */
  private sessionKey(code: string): string {
    return `session:${code}`;
  }

  /**
   * Gets the key for the topic index
   */
  private topicIndexKey(origin: string, topic: string): string {
    return `index:${origin}:${topic}`;
  }

  async createSession(origin: string, topic: string, info: string, offer: string, expiresAt: number): Promise<string> {
    // Validate info length
    if (info.length > 1024) {
      throw new Error('Info string must be 1024 characters or less');
    }

    const code = this.generateCode();
    const createdAt = Date.now();

    const session: Session = {
      code,
      origin,
      topic,
      info,
      offer,
      answer: undefined,
      offerCandidates: [],
      answerCandidates: [],
      createdAt,
      expiresAt,
    };

    // Calculate TTL in seconds for KV
    const ttl = Math.max(60, Math.floor((expiresAt - createdAt) / 1000));

    // Store the session
    await this.kv.put(
      this.sessionKey(code),
      JSON.stringify(session),
      { expirationTtl: ttl }
    );

    // Update the topic index
    const indexKey = this.topicIndexKey(origin, topic);
    const existingIndex = await this.kv.get(indexKey, 'json') as string[] | null;
    const updatedIndex = existingIndex ? [...existingIndex, code] : [code];

    // Set index TTL to slightly longer than session TTL to avoid race conditions
    await this.kv.put(
      indexKey,
      JSON.stringify(updatedIndex),
      { expirationTtl: ttl + 300 }
    );

    return code;
  }

  async listSessionsByTopic(origin: string, topic: string): Promise<Session[]> {
    const indexKey = this.topicIndexKey(origin, topic);
    const codes = await this.kv.get(indexKey, 'json') as string[] | null;

    if (!codes || codes.length === 0) {
      return [];
    }

    // Fetch all sessions in parallel
    const sessionPromises = codes.map(async (code) => {
      const sessionData = await this.kv.get(this.sessionKey(code), 'json') as Session | null;
      return sessionData;
    });

    const sessions = await Promise.all(sessionPromises);

    // Filter out expired or answered sessions, and null values
    const now = Date.now();
    const validSessions = sessions.filter(
      (session): session is Session =>
        session !== null &&
        session.expiresAt > now &&
        session.answer === undefined
    );

    // Sort by creation time (newest first)
    return validSessions.sort((a, b) => b.createdAt - a.createdAt);
  }

  async listTopics(origin: string, page: number, limit: number): Promise<{
    topics: Array<{ topic: string; count: number }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  }> {
    // Ensure limit doesn't exceed 1000
    const safeLimit = Math.min(Math.max(1, limit), 1000);
    const safePage = Math.max(1, page);

    const prefix = `index:${origin}:`;
    const topicCounts = new Map<string, number>();

    // List all index keys for this origin
    const list = await this.kv.list({ prefix });

    // Process each topic index
    for (const key of list.keys) {
      // Extract topic from key: "index:{origin}:{topic}"
      const topic = key.name.substring(prefix.length);

      // Get the session codes for this topic
      const codes = await this.kv.get(key.name, 'json') as string[] | null;

      if (!codes || codes.length === 0) {
        continue;
      }

      // Fetch sessions to count only valid ones (unexpired and unanswered)
      const sessionPromises = codes.map(async (code) => {
        const sessionData = await this.kv.get(this.sessionKey(code), 'json') as Session | null;
        return sessionData;
      });

      const sessions = await Promise.all(sessionPromises);

      // Count valid sessions
      const now = Date.now();
      const validCount = sessions.filter(
        (session) =>
          session !== null &&
          session.expiresAt > now &&
          session.answer === undefined
      ).length;

      if (validCount > 0) {
        topicCounts.set(topic, validCount);
      }
    }

    // Convert to array and sort by topic name
    const allTopics = Array.from(topicCounts.entries())
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => a.topic.localeCompare(b.topic));

    // Apply pagination
    const total = allTopics.length;
    const offset = (safePage - 1) * safeLimit;
    const topics = allTopics.slice(offset, offset + safeLimit);

    return {
      topics,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        hasMore: offset + topics.length < total,
      },
    };
  }

  async getSession(code: string, origin: string): Promise<Session | null> {
    const sessionData = await this.kv.get(this.sessionKey(code), 'json') as Session | null;

    if (!sessionData) {
      return null;
    }

    // Validate origin and expiration
    if (sessionData.origin !== origin || sessionData.expiresAt <= Date.now()) {
      return null;
    }

    return sessionData;
  }

  async updateSession(code: string, origin: string, update: Partial<Session>): Promise<void> {
    const current = await this.getSession(code, origin);

    if (!current) {
      throw new Error('Session not found or origin mismatch');
    }

    // Merge updates
    const updated: Session = {
      ...current,
      ...(update.answer !== undefined && { answer: update.answer }),
      ...(update.offerCandidates !== undefined && { offerCandidates: update.offerCandidates }),
      ...(update.answerCandidates !== undefined && { answerCandidates: update.answerCandidates }),
    };

    // Calculate remaining TTL
    const ttl = Math.max(60, Math.floor((updated.expiresAt - Date.now()) / 1000));

    // Update the session
    await this.kv.put(
      this.sessionKey(code),
      JSON.stringify(updated),
      { expirationTtl: ttl }
    );
  }

  async deleteSession(code: string): Promise<void> {
    await this.kv.delete(this.sessionKey(code));
  }

  async cleanup(): Promise<void> {
    // KV automatically expires keys based on TTL
    // No manual cleanup needed
  }

  async close(): Promise<void> {
    // No connection to close for KV
  }
}
