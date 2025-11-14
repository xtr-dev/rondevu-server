import { Storage, Offer, IceCandidate, CreateOfferRequest, TopicInfo } from './types.ts';

// Generate a UUID v4
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * D1 storage adapter for topic-based offer management using Cloudflare D1
 * NOTE: This implementation is a placeholder and needs to be fully tested
 */
export class D1Storage implements Storage {
  private db: D1Database;

  /**
   * Creates a new D1 storage instance
   * @param db D1Database instance from Cloudflare Workers environment
   */
  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Initializes database schema with new topic-based structure
   * This should be run once during setup, not on every request
   */
  async initializeDatabase(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        sdp TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        answerer_peer_id TEXT,
        answer_sdp TEXT,
        answered_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_offers_peer ON offers(peer_id);
      CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at);
      CREATE INDEX IF NOT EXISTS idx_offers_last_seen ON offers(last_seen);
      CREATE INDEX IF NOT EXISTS idx_offers_answerer ON offers(answerer_peer_id);

      CREATE TABLE IF NOT EXISTS offer_topics (
        offer_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        PRIMARY KEY (offer_id, topic),
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_topics_topic ON offer_topics(topic);
      CREATE INDEX IF NOT EXISTS idx_topics_offer ON offer_topics(offer_id);

      CREATE TABLE IF NOT EXISTS ice_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('offerer', 'answerer')),
        candidate TEXT NOT NULL,
        sdp_mid TEXT,
        sdp_m_line_index INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_peer ON ice_candidates(peer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at);
    `);
  }

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    const created: Offer[] = [];

    // D1 doesn't support true transactions yet, so we do this sequentially
    for (const offer of offers) {
      const id = offer.id || generateUUID();
      const now = Date.now();

      // Insert offer
      await this.db.prepare(`
        INSERT INTO offers (id, peer_id, sdp, created_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(id, offer.peerId, offer.sdp, now, offer.expiresAt, now).run();

      // Insert topics
      for (const topic of offer.topics) {
        await this.db.prepare(`
          INSERT INTO offer_topics (offer_id, topic)
          VALUES (?, ?)
        `).bind(id, topic).run();
      }

      created.push({
        id,
        peerId: offer.peerId,
        sdp: offer.sdp,
        topics: offer.topics,
        createdAt: now,
        expiresAt: offer.expiresAt,
        lastSeen: now,
      });
    }

    return created;
  }

  async getOffersByTopic(topic: string, excludePeerIds?: string[]): Promise<Offer[]> {
    let query = `
      SELECT DISTINCT o.*
      FROM offers o
      INNER JOIN offer_topics ot ON o.id = ot.offer_id
      WHERE ot.topic = ? AND o.expires_at > ?
    `;

    const params: any[] = [topic, Date.now()];

    if (excludePeerIds && excludePeerIds.length > 0) {
      const placeholders = excludePeerIds.map(() => '?').join(',');
      query += ` AND o.peer_id NOT IN (${placeholders})`;
      params.push(...excludePeerIds);
    }

    query += ' ORDER BY o.last_seen DESC';

    const result = await this.db.prepare(query).bind(...params).all();

    if (!result.results) {
      return [];
    }

    return Promise.all(result.results.map(row => this.rowToOffer(row as any)));
  }

  async getOffersByPeerId(peerId: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE peer_id = ? AND expires_at > ?
      ORDER BY last_seen DESC
    `).bind(peerId, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return Promise.all(result.results.map(row => this.rowToOffer(row as any)));
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

  async updateOfferLastSeen(offerId: string, lastSeen: number): Promise<void> {
    await this.db.prepare(`
      UPDATE offers
      SET last_seen = ?
      WHERE id = ? AND expires_at > ?
    `).bind(lastSeen, offerId, Date.now()).run();
  }

  async deleteOffer(offerId: string, ownerPeerId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM offers
      WHERE id = ? AND peer_id = ?
    `).bind(offerId, ownerPeerId).run();

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
    answererPeerId: string,
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
    if (offer.answererPeerId) {
      return {
        success: false,
        error: 'Offer already answered'
      };
    }

    // Update offer with answer
    const result = await this.db.prepare(`
      UPDATE offers
      SET answerer_peer_id = ?, answer_sdp = ?, answered_at = ?
      WHERE id = ? AND answerer_peer_id IS NULL
    `).bind(answererPeerId, answerSdp, Date.now(), offerId).run();

    if ((result.meta.changes || 0) === 0) {
      return {
        success: false,
        error: 'Offer already answered (race condition)'
      };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererPeerId: string): Promise<Offer[]> {
    const result = await this.db.prepare(`
      SELECT * FROM offers
      WHERE peer_id = ? AND answerer_peer_id IS NOT NULL AND expires_at > ?
      ORDER BY answered_at DESC
    `).bind(offererPeerId, Date.now()).all();

    if (!result.results) {
      return [];
    }

    return Promise.all(result.results.map(row => this.rowToOffer(row as any)));
  }

  async addIceCandidates(
    offerId: string,
    peerId: string,
    role: 'offerer' | 'answerer',
    candidates: Array<{
      candidate: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    }>
  ): Promise<number> {
    // D1 doesn't have transactions, so insert one by one
    for (const cand of candidates) {
      await this.db.prepare(`
        INSERT INTO ice_candidates (offer_id, peer_id, role, candidate, sdp_mid, sdp_m_line_index, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        offerId,
        peerId,
        role,
        cand.candidate,
        cand.sdpMid ?? null,
        cand.sdpMLineIndex ?? null,
        Date.now()
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
      peerId: row.peer_id,
      role: row.role,
      candidate: row.candidate,
      sdpMid: row.sdp_mid,
      sdpMLineIndex: row.sdp_m_line_index,
      createdAt: row.created_at,
    }));
  }

  async getTopics(limit: number, offset: number): Promise<{
    topics: TopicInfo[];
    total: number;
  }> {
    // Get total count of topics with active offers
    const countResult = await this.db.prepare(`
      SELECT COUNT(DISTINCT ot.topic) as count
      FROM offer_topics ot
      INNER JOIN offers o ON ot.offer_id = o.id
      WHERE o.expires_at > ?
    `).bind(Date.now()).first();

    const total = (countResult as any)?.count || 0;

    // Get topics with peer counts (paginated)
    const topicsResult = await this.db.prepare(`
      SELECT
        ot.topic,
        COUNT(DISTINCT o.peer_id) as active_peers
      FROM offer_topics ot
      INNER JOIN offers o ON ot.offer_id = o.id
      WHERE o.expires_at > ?
      GROUP BY ot.topic
      ORDER BY active_peers DESC, ot.topic ASC
      LIMIT ? OFFSET ?
    `).bind(Date.now(), limit, offset).all();

    const topics = (topicsResult.results || []).map((row: any) => ({
      topic: row.topic,
      activePeers: row.active_peers,
    }));

    return { topics, total };
  }

  async close(): Promise<void> {
    // D1 doesn't require explicit connection closing
    // Connections are managed by the Cloudflare Workers runtime
  }

  /**
   * Helper method to convert database row to Offer object with topics
   */
  private async rowToOffer(row: any): Promise<Offer> {
    // Get topics for this offer
    const topicResult = await this.db.prepare(`
      SELECT topic FROM offer_topics WHERE offer_id = ?
    `).bind(row.id).all();

    const topics = topicResult.results?.map((t: any) => t.topic) || [];

    return {
      id: row.id,
      peerId: row.peer_id,
      sdp: row.sdp,
      topics,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeen: row.last_seen,
      answererPeerId: row.answerer_peer_id || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at || undefined,
    };
  }
}
