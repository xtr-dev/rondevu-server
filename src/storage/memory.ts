import {
  Storage,
  Offer,
  IceCandidate,
  CreateOfferRequest,
} from './types.ts';
import { generateOfferHash } from './hash-id.ts';

interface RateLimit {
  count: number;
  resetTime: number;
}

interface NonceEntry {
  expiresAt: number;
}

/**
 * In-memory storage adapter for rondevu signaling system
 * Data is not persisted - all data is lost on server restart
 * Best for development, testing, or ephemeral deployments
 */
export class MemoryStorage implements Storage {
  // Primary storage
  private offers = new Map<string, Offer>();
  private iceCandidates = new Map<string, IceCandidate[]>(); // offerId → candidates
  private rateLimits = new Map<string, RateLimit>();
  private nonces = new Map<string, NonceEntry>();

  // Secondary indexes for efficient lookups
  private offersByPublicKey = new Map<string, Set<string>>(); // publicKey → offer IDs
  private offersByTag = new Map<string, Set<string>>(); // tag → offer IDs
  private offersByAnswerer = new Map<string, Set<string>>(); // answerer publicKey → offer IDs

  // Auto-increment counter for ICE candidates
  private iceCandidateIdCounter = 0;

  constructor() {}

  // ===== Offer Management =====

  async createOffers(offers: CreateOfferRequest[]): Promise<Offer[]> {
    const created: Offer[] = [];
    const now = Date.now();

    for (const request of offers) {
      const id = request.id || await generateOfferHash(request.sdp);

      const offer: Offer = {
        id,
        publicKey: request.publicKey,
        tags: request.tags,
        sdp: request.sdp,
        createdAt: now,
        expiresAt: request.expiresAt,
        lastSeen: now,
      };

      // Store offer
      this.offers.set(id, offer);

      // Update publicKey index
      if (!this.offersByPublicKey.has(request.publicKey)) {
        this.offersByPublicKey.set(request.publicKey, new Set());
      }
      this.offersByPublicKey.get(request.publicKey)!.add(id);

      // Update tag indexes
      for (const tag of request.tags) {
        if (!this.offersByTag.has(tag)) {
          this.offersByTag.set(tag, new Set());
        }
        this.offersByTag.get(tag)!.add(id);
      }

      created.push(offer);
    }

    return created;
  }

  async getOffersByPublicKey(publicKey: string): Promise<Offer[]> {
    const now = Date.now();
    const offerIds = this.offersByPublicKey.get(publicKey);
    if (!offerIds) return [];

    const offers: Offer[] = [];
    for (const id of offerIds) {
      const offer = this.offers.get(id);
      if (offer && offer.expiresAt > now) {
        offers.push(offer);
      }
    }

    return offers.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  async getOfferById(offerId: string): Promise<Offer | null> {
    const offer = this.offers.get(offerId);
    if (!offer || offer.expiresAt <= Date.now()) {
      return null;
    }
    return offer;
  }

  async deleteOffer(offerId: string, ownerPublicKey: string): Promise<boolean> {
    const offer = this.offers.get(offerId);
    if (!offer || offer.publicKey !== ownerPublicKey) {
      return false;
    }

    this.removeOfferFromIndexes(offer);
    this.offers.delete(offerId);
    this.iceCandidates.delete(offerId);

    return true;
  }

  async deleteExpiredOffers(now: number): Promise<number> {
    let count = 0;

    for (const [id, offer] of this.offers) {
      if (offer.expiresAt < now) {
        this.removeOfferFromIndexes(offer);
        this.offers.delete(id);
        this.iceCandidates.delete(id);
        count++;
      }
    }

    return count;
  }

  async answerOffer(
    offerId: string,
    answererPublicKey: string,
    answerSdp: string,
    matchedTags?: string[],
    newExpiresAt?: number
  ): Promise<{ success: boolean; error?: string }> {
    const offer = await this.getOfferById(offerId);

    if (!offer) {
      return { success: false, error: 'Offer not found or expired' };
    }

    if (offer.answererPublicKey) {
      return { success: false, error: 'Offer already answered' };
    }

    // Update offer with answer
    const now = Date.now();
    offer.answererPublicKey = answererPublicKey;
    offer.answerSdp = answerSdp;
    offer.answeredAt = now;
    offer.matchedTags = matchedTags;

    // Optionally reduce TTL for faster cleanup after answer
    if (newExpiresAt !== undefined) {
      offer.expiresAt = newExpiresAt;
    }

    // Update answerer index
    if (!this.offersByAnswerer.has(answererPublicKey)) {
      this.offersByAnswerer.set(answererPublicKey, new Set());
    }
    this.offersByAnswerer.get(answererPublicKey)!.add(offerId);

    return { success: true };
  }

  async getAnsweredOffers(offererPublicKey: string): Promise<Offer[]> {
    const now = Date.now();
    const offerIds = this.offersByPublicKey.get(offererPublicKey);
    if (!offerIds) return [];

    const offers: Offer[] = [];
    for (const id of offerIds) {
      const offer = this.offers.get(id);
      if (offer && offer.answererPublicKey && offer.expiresAt > now) {
        offers.push(offer);
      }
    }

    return offers.sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0));
  }

  async getOffersAnsweredBy(answererPublicKey: string): Promise<Offer[]> {
    const now = Date.now();
    const offerIds = this.offersByAnswerer.get(answererPublicKey);
    if (!offerIds) return [];

    const offers: Offer[] = [];
    for (const id of offerIds) {
      const offer = this.offers.get(id);
      if (offer && offer.expiresAt > now) {
        offers.push(offer);
      }
    }

    return offers.sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0));
  }

  // ===== Discovery =====

  async discoverOffers(
    tags: string[],
    excludePublicKey: string | null,
    limit: number,
    offset: number
  ): Promise<Offer[]> {
    if (tags.length === 0) return [];

    const now = Date.now();
    const matchingOfferIds = new Set<string>();

    // Find all offers matching any tag (OR logic)
    for (const tag of tags) {
      const offerIds = this.offersByTag.get(tag);
      if (offerIds) {
        for (const id of offerIds) {
          matchingOfferIds.add(id);
        }
      }
    }

    // Filter and collect matching offers
    const offers: Offer[] = [];
    for (const id of matchingOfferIds) {
      const offer = this.offers.get(id);
      if (
        offer &&
        offer.expiresAt > now &&
        !offer.answererPublicKey &&
        (!excludePublicKey || offer.publicKey !== excludePublicKey)
      ) {
        offers.push(offer);
      }
    }

    // Sort by created_at descending and apply pagination
    offers.sort((a, b) => b.createdAt - a.createdAt);
    return offers.slice(offset, offset + limit);
  }

  async getRandomOffer(
    tags: string[],
    excludePublicKey: string | null
  ): Promise<Offer | null> {
    if (tags.length === 0) return null;

    const now = Date.now();
    const matchingOffers: Offer[] = [];

    // Find all offers matching any tag (OR logic)
    const matchingOfferIds = new Set<string>();
    for (const tag of tags) {
      const offerIds = this.offersByTag.get(tag);
      if (offerIds) {
        for (const id of offerIds) {
          matchingOfferIds.add(id);
        }
      }
    }

    // Collect matching offers
    for (const id of matchingOfferIds) {
      const offer = this.offers.get(id);
      if (
        offer &&
        offer.expiresAt > now &&
        !offer.answererPublicKey &&
        (!excludePublicKey || offer.publicKey !== excludePublicKey)
      ) {
        matchingOffers.push(offer);
      }
    }

    if (matchingOffers.length === 0) return null;

    // Return random offer
    const randomIndex = Math.floor(Math.random() * matchingOffers.length);
    return matchingOffers[randomIndex];
  }

  // ===== ICE Candidate Management =====

  async addIceCandidates(
    offerId: string,
    publicKey: string,
    role: 'offerer' | 'answerer',
    candidates: any[]
  ): Promise<number> {
    const baseTimestamp = Date.now();

    if (!this.iceCandidates.has(offerId)) {
      this.iceCandidates.set(offerId, []);
    }

    const candidateList = this.iceCandidates.get(offerId)!;

    for (let i = 0; i < candidates.length; i++) {
      const candidate: IceCandidate = {
        id: ++this.iceCandidateIdCounter,
        offerId,
        publicKey,
        role,
        candidate: candidates[i],
        createdAt: baseTimestamp + i,
      };
      candidateList.push(candidate);
    }

    return candidates.length;
  }

  async getIceCandidates(
    offerId: string,
    targetRole: 'offerer' | 'answerer',
    since?: number
  ): Promise<IceCandidate[]> {
    const candidates = this.iceCandidates.get(offerId) || [];

    return candidates
      .filter(c => c.role === targetRole && (since === undefined || c.createdAt > since))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getIceCandidatesForMultipleOffers(
    offerIds: string[],
    publicKey: string,
    since?: number
  ): Promise<Map<string, IceCandidate[]>> {
    const result = new Map<string, IceCandidate[]>();

    if (offerIds.length === 0) return result;
    if (offerIds.length > 1000) {
      throw new Error('Too many offer IDs (max 1000)');
    }

    for (const offerId of offerIds) {
      const offer = this.offers.get(offerId);
      if (!offer) continue;

      const candidates = this.iceCandidates.get(offerId) || [];

      // Determine which role's candidates to return
      // If user is offerer, return answerer candidates and vice versa
      const isOfferer = offer.publicKey === publicKey;
      const isAnswerer = offer.answererPublicKey === publicKey;

      if (!isOfferer && !isAnswerer) continue;

      const targetRole = isOfferer ? 'answerer' : 'offerer';

      const filteredCandidates = candidates
        .filter(c => c.role === targetRole && (since === undefined || c.createdAt > since))
        .sort((a, b) => a.createdAt - b.createdAt);

      if (filteredCandidates.length > 0) {
        result.set(offerId, filteredCandidates);
      }
    }

    return result;
  }

  // ===== Rate Limiting =====

  async checkRateLimit(identifier: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.rateLimits.get(identifier);

    if (!existing || existing.resetTime < now) {
      // New window or expired - reset count
      this.rateLimits.set(identifier, {
        count: 1,
        resetTime: now + windowMs,
      });
      return true;
    }

    // Increment count in existing window
    existing.count++;
    return existing.count <= limit;
  }

  async deleteExpiredRateLimits(now: number): Promise<number> {
    let count = 0;
    for (const [identifier, rateLimit] of this.rateLimits) {
      if (rateLimit.resetTime < now) {
        this.rateLimits.delete(identifier);
        count++;
      }
    }
    return count;
  }

  // ===== Nonce Tracking (Replay Protection) =====

  async checkAndMarkNonce(nonceKey: string, expiresAt: number): Promise<boolean> {
    if (this.nonces.has(nonceKey)) {
      return false; // Nonce already used - replay attack
    }

    this.nonces.set(nonceKey, { expiresAt });
    return true; // Nonce is new - allowed
  }

  async deleteExpiredNonces(now: number): Promise<number> {
    let count = 0;
    for (const [key, entry] of this.nonces) {
      if (entry.expiresAt < now) {
        this.nonces.delete(key);
        count++;
      }
    }
    return count;
  }

  async close(): Promise<void> {
    // Clear all data
    this.offers.clear();
    this.iceCandidates.clear();
    this.rateLimits.clear();
    this.nonces.clear();
    this.offersByPublicKey.clear();
    this.offersByTag.clear();
    this.offersByAnswerer.clear();
  }

  // ===== Count Methods (for resource limits) =====

  async getOfferCount(): Promise<number> {
    return this.offers.size;
  }

  async getOfferCountByPublicKey(publicKey: string): Promise<number> {
    const offerIds = this.offersByPublicKey.get(publicKey);
    return offerIds ? offerIds.size : 0;
  }

  async getIceCandidateCount(offerId: string): Promise<number> {
    const candidates = this.iceCandidates.get(offerId);
    return candidates ? candidates.length : 0;
  }

  async countOffersByTags(tags: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (tags.length === 0) return result;

    const now = Date.now();

    for (const tag of tags) {
      const offerIds = this.offersByTag.get(tag);
      if (!offerIds) {
        result.set(tag, 0);
        continue;
      }

      let count = 0;
      for (const offerId of offerIds) {
        const offer = this.offers.get(offerId);
        if (offer && offer.expiresAt > now && !offer.answererPublicKey) {
          count++;
        }
      }
      result.set(tag, count);
    }

    return result;
  }

  // ===== Helper Methods =====

  private removeOfferFromIndexes(offer: Offer): void {
    // Remove from publicKey index
    const publicKeyOffers = this.offersByPublicKey.get(offer.publicKey);
    if (publicKeyOffers) {
      publicKeyOffers.delete(offer.id);
      if (publicKeyOffers.size === 0) {
        this.offersByPublicKey.delete(offer.publicKey);
      }
    }

    // Remove from tag indexes
    for (const tag of offer.tags) {
      const tagOffers = this.offersByTag.get(tag);
      if (tagOffers) {
        tagOffers.delete(offer.id);
        if (tagOffers.size === 0) {
          this.offersByTag.delete(tag);
        }
      }
    }

    // Remove from answerer index
    if (offer.answererPublicKey) {
      const answererOffers = this.offersByAnswerer.get(offer.answererPublicKey);
      if (answererOffers) {
        answererOffers.delete(offer.id);
        if (answererOffers.size === 0) {
          this.offersByAnswerer.delete(offer.answererPublicKey);
        }
      }
    }
  }
}
