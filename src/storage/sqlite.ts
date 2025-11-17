import Database from 'better-sqlite3';
import { Storage, Offer, IceCandidate, CreateOfferRequest, TopicInfo } from './types.ts';
import { generateOfferHash } from './hash-id.ts';

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
        secret TEXT,
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
        candidate TEXT NOT NULL, -- JSON: RTCIceCandidateInit object
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

    // Generate hash-based IDs for all offers first
    const offersWithIds = await Promise.all(
      offers.map(async (offer) => ({
        ...offer,
        id: offer.id || await generateOfferHash(offer.sdp, offer.topics),
      }))
    );

    // Use transaction for atomic creation
    const transaction = this.db.transaction((offersWithIds: (CreateOfferRequest & { id: string })[]) => {
      const offerStmt = this.db.prepare(`
        INSERT INTO offers (id, peer_id, sdp, created_at, expires_at, last_seen, secret)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const topicStmt = this.db.prepare(`
        INSERT INTO offer_topics (offer_id, topic)
        VALUES (?, ?)
      `);

      for (const offer of offersWithIds) {
        const now = Date.now();

        // Insert offer
        offerStmt.run(
          offer.id,
          offer.peerId,
          offer.sdp,
          now,
          offer.expiresAt,
          now,
          offer.secret || null
        );

        // Insert topics
        for (const topic of offer.topics) {
          topicStmt.run(offer.id, topic);
        }

        created.push({
          id: offer.id,
          peerId: offer.peerId,
          sdp: offer.sdp,
          topics: offer.topics,
          createdAt: now,
          expiresAt: offer.expiresAt,
          lastSeen: now,
          secret: offer.secret,
        });
      }
    });

    transaction(offersWithIds);
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
    answerSdp: string,
    secret?: string
  ): Promise<{ success: boolean; error?: string }> {
    // Check if offer exists and is not expired
    const offer = await this.getOfferById(offerId);

    if (!offer) {
      return {
        success: false,
        error: 'Offer not found or expired'
      };
    }

    // Verify secret if offer is protected
    if (offer.secret && offer.secret !== secret) {
      return {
        success: false,
        error: 'Invalid or missing secret'
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
    candidates: any[]
  ): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO ice_candidates (offer_id, peer_id, role, candidate, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const baseTimestamp = Date.now();
    const transaction = this.db.transaction((candidates: any[]) => {
      for (let i = 0; i < candidates.length; i++) {
        stmt.run(
          offerId,
          peerId,
          role,
          JSON.stringify(candidates[i]), // Store full object as JSON
          baseTimestamp + i // Ensure unique timestamps to avoid "since" filtering issues
        );
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
      candidate: JSON.parse(row.candidate), // Parse JSON back to object
      createdAt: row.created_at,
    }));
  }

  async getTopics(limit: number, offset: number, startsWith?: string): Promise<{
    topics: TopicInfo[];
    total: number;
  }> {
    const now = Date.now();

    // Build WHERE clause for startsWith filter
    const whereClause = startsWith
      ? 'o.expires_at > ? AND ot.topic LIKE ?'
      : 'o.expires_at > ?';

    const startsWithPattern = startsWith ? `${startsWith}%` : null;

    // Get total count of topics with active offers
    const countQuery = `
      SELECT COUNT(DISTINCT ot.topic) as count
      FROM offer_topics ot
      INNER JOIN offers o ON ot.offer_id = o.id
      WHERE ${whereClause}
    `;

    const countStmt = this.db.prepare(countQuery);
    const countParams = startsWith ? [now, startsWithPattern] : [now];
    const countRow = countStmt.get(...countParams) as any;
    const total = countRow.count;

    // Get topics with peer counts (paginated)
    const topicsQuery = `
      SELECT
        ot.topic,
        COUNT(DISTINCT o.peer_id) as active_peers
      FROM offer_topics ot
      INNER JOIN offers o ON ot.offer_id = o.id
      WHERE ${whereClause}
      GROUP BY ot.topic
      ORDER BY active_peers DESC, ot.topic ASC
      LIMIT ? OFFSET ?
    `;

    const topicsStmt = this.db.prepare(topicsQuery);
    const topicsParams = startsWith
      ? [now, startsWithPattern, limit, offset]
      : [now, limit, offset];
    const rows = topicsStmt.all(...topicsParams) as any[];

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
      secret: row.secret || undefined,
      answererPeerId: row.answerer_peer_id || undefined,
      answerSdp: row.answer_sdp || undefined,
      answeredAt: row.answered_at || undefined,
    };
  }
}
