import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Storage, Offer, IceCandidate, CreateOfferRequest, TopicInfo } from './types.ts';

/**
 * SQLite storage adapter for topic-based offer management
 * Supports both file-based and in-memory databases
 */
export class SQLiteStorage implements Storage {
  private db: Database.Database;

  /**
   * Creates a new SQLite storage instance
   * @param path Path to SQLite database file, or ':memory:' for in-memory database
   */
  constructor(path: string = ':memory:') {
    this.db = new Database(path);
    this.initializeDatabase();
  }

  /**
   * Initializes database schema with new topic-based structure
   */
  private initializeDatabase(): void {
    this.db.exec(`
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
        created_at INTEGER NOT NULL,
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ice_offer ON ice_candidates(offer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_peer ON ice_candidates(peer_id);
      CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_candidates(created_at);
    `);

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
  }

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    const created: Offer[] = [];

    // Use transaction for atomic creation
    const transaction = this.db.transaction((offers: CreateOfferRequest[]) => {
      const offerStmt = this.db.prepare(`
        INSERT INTO offers (id, peer_id, sdp, created_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const topicStmt = this.db.prepare(`
        INSERT INTO offer_topics (offer_id, topic)
        VALUES (?, ?)
      `);

      for (const offer of offers) {
        const id = offer.id || randomUUID();
        const now = Date.now();

        // Insert offer
        offerStmt.run(
          id,
          offer.peerId,
          offer.sdp,
          now,
          offer.expiresAt,
          now
        );

        // Insert topics
        for (const topic of offer.topics) {
          topicStmt.run(id, topic);
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
    });

    transaction(offers);
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

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return Promise.all(rows.map(row => this.rowToOffer(row)));
  }

  async getOffersByPeerId(peerId: string): Promise<Offer[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE peer_id = ? AND expires_at > ?
      ORDER BY last_seen DESC
    `);

    const rows = stmt.all(peerId, Date.now()) as any[];
    return Promise.all(rows.map(row => this.rowToOffer(row)));
  }

  async getOfferById(offerId: string): Promise<Offer | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE id = ? AND expires_at > ?
    `);

    const row = stmt.get(offerId, Date.now()) as any;

    if (!row) {
      return null;
    }

    return this.rowToOffer(row);
  }

  async updateOfferLastSeen(offerId: string, lastSeen: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE offers
      SET last_seen = ?
      WHERE id = ? AND expires_at > ?
    `);

    stmt.run(lastSeen, offerId, Date.now());
  }

  async deleteOffer(offerId: string, ownerPeerId: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      DELETE FROM offers
      WHERE id = ? AND peer_id = ?
    `);

    const result = stmt.run(offerId, ownerPeerId);
    return result.changes > 0;
  }

  async deleteExpiredOffers(now: number): Promise<number> {
    const stmt = this.db.prepare('DELETE FROM offers WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
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
    const stmt = this.db.prepare(`
      UPDATE offers
      SET answerer_peer_id = ?, answer_sdp = ?, answered_at = ?
      WHERE id = ? AND answerer_peer_id IS NULL
    `);

    const result = stmt.run(answererPeerId, answerSdp, Date.now(), offerId);

    if (result.changes === 0) {
      return {
        success: false,
        error: 'Offer already answered (race condition)'
      };
    }

    return { success: true };
  }

  async getAnsweredOffers(offererPeerId: string): Promise<Offer[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM offers
      WHERE peer_id = ? AND answerer_peer_id IS NOT NULL AND expires_at > ?
      ORDER BY answered_at DESC
    `);

    const rows = stmt.all(offererPeerId, Date.now()) as any[];
    return Promise.all(rows.map(row => this.rowToOffer(row)));
  }

  async addIceCandidates(
    offerId: string,
    peerId: string,
    role: 'offerer' | 'answerer',
    candidates: string[]
  ): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO ice_candidates (offer_id, peer_id, role, candidate, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((candidates: string[]) => {
      for (const candidate of candidates) {
        stmt.run(offerId, peerId, role, candidate, Date.now());
      }
    });

    transaction(candidates);
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

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      offerId: row.offer_id,
      peerId: row.peer_id,
      role: row.role,
      candidate: row.candidate,
      createdAt: row.created_at,
    }));
  }

  async getTopics(limit: number, offset: number): Promise<{
    topics: TopicInfo[];
    total: number;
  }> {
    // Get total count of topics with active offers
    const countStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT ot.topic) as count
      FROM offer_topics ot
      INNER JOIN offers o ON ot.offer_id = o.id
      WHERE o.expires_at > ?
    `);

    const countRow = countStmt.get(Date.now()) as any;
    const total = countRow.count;

    // Get topics with peer counts (paginated)
    const topicsStmt = this.db.prepare(`
      SELECT
        ot.topic,
        COUNT(DISTINCT o.peer_id) as active_peers
      FROM offer_topics ot
      INNER JOIN offers o ON ot.offer_id = o.id
      WHERE o.expires_at > ?
      GROUP BY ot.topic
      ORDER BY active_peers DESC, ot.topic ASC
      LIMIT ? OFFSET ?
    `);

    const rows = topicsStmt.all(Date.now(), limit, offset) as any[];

    const topics = rows.map(row => ({
      topic: row.topic,
      activePeers: row.active_peers,
    }));

    return { topics, total };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Helper method to convert database row to Offer object with topics
   */
  private async rowToOffer(row: any): Promise<Offer> {
    // Get topics for this offer
    const topicStmt = this.db.prepare(`
      SELECT topic FROM offer_topics WHERE offer_id = ?
    `);

    const topicRows = topicStmt.all(row.id) as any[];
    const topics = topicRows.map(t => t.topic);

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
