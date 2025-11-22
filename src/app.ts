import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import { createAuthMiddleware, getAuthenticatedPeerId } from './middleware/auth.ts';
import { generatePeerId, encryptPeerId } from './crypto.ts';
import { parseBloomFilter } from './bloom.ts';
import type { Context } from 'hono';

/**
 * Creates the Hono application with topic-based WebRTC signaling endpoints
 */
export function createApp(storage: Storage, config: Config) {
  const app = new Hono();

  // Create auth middleware
  const authMiddleware = createAuthMiddleware(config.authSecret);

  // Enable CORS with dynamic origin handling
  app.use('/*', cors({
    origin: (origin) => {
      // If no origin restrictions (wildcard), allow any origin
      if (config.corsOrigins.length === 1 && config.corsOrigins[0] === '*') {
        return origin;
      }
      // Otherwise check if origin is in allowed list
      if (config.corsOrigins.includes(origin)) {
        return origin;
      }
      // Default to first allowed origin
      return config.corsOrigins[0];
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Origin', 'Authorization'],
    exposeHeaders: ['Content-Type'],
    maxAge: 600,
    credentials: true,
  }));

  /**
   * GET /
   * Returns server version information
   */
  app.get('/', (c) => {
    return c.json({
      version: config.version,
      name: 'Rondevu',
      description: 'Topic-based peer discovery and signaling server'
    });
  });

  /**
   * GET /health
   * Health check endpoint with version
   */
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: Date.now(),
      version: config.version
    });
  });

  /**
   * POST /register
   * Register a new peer and receive credentials
   * Accepts optional peerId in request body for custom peer IDs
   */
  app.post('/register', async (c) => {
    try {
      let peerId: string;

      // Check if custom peer ID is provided
      const body = await c.req.json().catch(() => ({}));
      const customPeerId = body.peerId;

      if (customPeerId !== undefined) {
        // Validate custom peer ID
        if (typeof customPeerId !== 'string' || customPeerId.length === 0) {
          return c.json({ error: 'Peer ID must be a non-empty string' }, 400);
        }

        if (customPeerId.length > 128) {
          return c.json({ error: 'Peer ID must be 128 characters or less' }, 400);
        }

        // Check if peer ID is already in use by checking for active offers
        const existingOffers = await storage.getOffersByPeerId(customPeerId);
        if (existingOffers.length > 0) {
          return c.json({ error: 'Peer ID is already in use' }, 409);
        }

        peerId = customPeerId;
      } else {
        // Generate new peer ID
        peerId = generatePeerId();
      }

      // Encrypt peer ID with server secret (async operation)
      const secret = await encryptPeerId(peerId, config.authSecret);

      return c.json({
        peerId,
        secret
      }, 200);
    } catch (err) {
      console.error('Error registering peer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /offers
   * Creates one or more offers with topics
   * Requires authentication
   */
  app.post('/offers', authMiddleware, async (c) => {
    try {
      const body = await c.req.json();
      const { offers } = body;

      if (!Array.isArray(offers) || offers.length === 0) {
        return c.json({ error: 'Missing or invalid required parameter: offers (must be non-empty array)' }, 400);
      }

      if (offers.length > config.maxOffersPerRequest) {
        return c.json({ error: `Too many offers. Maximum ${config.maxOffersPerRequest} per request` }, 400);
      }

      const peerId = getAuthenticatedPeerId(c);

      // Validate and prepare offers
      const offerRequests = [];
      for (const offer of offers) {
        // Validate SDP
        if (!offer.sdp || typeof offer.sdp !== 'string') {
          return c.json({ error: 'Each offer must have an sdp field' }, 400);
        }

        if (offer.sdp.length > 65536) {
          return c.json({ error: 'SDP must be 64KB or less' }, 400);
        }

        // Validate secret if provided
        if (offer.secret !== undefined) {
          if (typeof offer.secret !== 'string') {
            return c.json({ error: 'Secret must be a string' }, 400);
          }
          if (offer.secret.length > 128) {
            return c.json({ error: 'Secret must be 128 characters or less' }, 400);
          }
        }

        // Validate info if provided
        if (offer.info !== undefined) {
          if (typeof offer.info !== 'string') {
            return c.json({ error: 'Info must be a string' }, 400);
          }
          if (offer.info.length > 128) {
            return c.json({ error: 'Info must be 128 characters or less' }, 400);
          }
        }

        // Validate topics
        if (!Array.isArray(offer.topics) || offer.topics.length === 0) {
          return c.json({ error: 'Each offer must have a non-empty topics array' }, 400);
        }

        if (offer.topics.length > config.maxTopicsPerOffer) {
          return c.json({ error: `Too many topics. Maximum ${config.maxTopicsPerOffer} per offer` }, 400);
        }

        for (const topic of offer.topics) {
          if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256) {
            return c.json({ error: 'Each topic must be a string between 1 and 256 characters' }, 400);
          }
        }

        // Validate and clamp TTL
        let ttl = offer.ttl || config.offerDefaultTtl;
        if (ttl < config.offerMinTtl) {
          ttl = config.offerMinTtl;
        }
        if (ttl > config.offerMaxTtl) {
          ttl = config.offerMaxTtl;
        }

        offerRequests.push({
          id: offer.id,
          peerId,
          sdp: offer.sdp,
          topics: offer.topics,
          expiresAt: Date.now() + ttl,
          secret: offer.secret,
          info: offer.info,
        });
      }

      // Create offers
      const createdOffers = await storage.createOffers(offerRequests);

      // Return simplified response
      return c.json({
        offers: createdOffers.map(o => ({
          id: o.id,
          peerId: o.peerId,
          topics: o.topics,
          expiresAt: o.expiresAt
        }))
      }, 200);
    } catch (err) {
      console.error('Error creating offers:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/by-topic/:topic
   * Find offers by topic with optional bloom filter exclusion
   * Public endpoint (no auth required)
   */
  app.get('/offers/by-topic/:topic', async (c) => {
    try {
      const topic = c.req.param('topic');
      const bloomParam = c.req.query('bloom');
      const limitParam = c.req.query('limit');

      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 200) : 50;

      // Parse bloom filter if provided
      let excludePeerIds: string[] = [];
      if (bloomParam) {
        const bloom = parseBloomFilter(bloomParam);
        if (!bloom) {
          return c.json({ error: 'Invalid bloom filter format' }, 400);
        }

        // Get all offers for topic first
        const allOffers = await storage.getOffersByTopic(topic);

        // Test each peer ID against bloom filter
        const excludeSet = new Set<string>();
        for (const offer of allOffers) {
          if (bloom.test(offer.peerId)) {
            excludeSet.add(offer.peerId);
          }
        }

        excludePeerIds = Array.from(excludeSet);
      }

      // Get filtered offers
      let offers = await storage.getOffersByTopic(topic, excludePeerIds.length > 0 ? excludePeerIds : undefined);

      // Apply limit
      const total = offers.length;
      offers = offers.slice(0, limit);

      return c.json({
        topic,
        offers: offers.map(o => ({
          id: o.id,
          peerId: o.peerId,
          sdp: o.sdp,
          topics: o.topics,
          expiresAt: o.expiresAt,
          lastSeen: o.lastSeen,
          hasSecret: !!o.secret,  // Indicate if secret is required without exposing it
          info: o.info  // Public info field
        })),
        total: bloomParam ? total + excludePeerIds.length : total,
        returned: offers.length
      }, 200);
    } catch (err) {
      console.error('Error fetching offers by topic:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /topics
   * List all topics with active peer counts (paginated)
   * Public endpoint (no auth required)
   * Query params:
   *   - limit: Max topics to return (default 50, max 200)
   *   - offset: Number of topics to skip (default 0)
   *   - startsWith: Filter topics starting with this prefix (optional)
   */
  app.get('/topics', async (c) => {
    try {
      const limitParam = c.req.query('limit');
      const offsetParam = c.req.query('offset');
      const startsWithParam = c.req.query('startsWith');

      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 200) : 50;
      const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
      const startsWith = startsWithParam || undefined;

      const result = await storage.getTopics(limit, offset, startsWith);

      return c.json({
        topics: result.topics,
        total: result.total,
        limit,
        offset,
        ...(startsWith && { startsWith })
      }, 200);
    } catch (err) {
      console.error('Error fetching topics:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /peers/:peerId/offers
   * View all offers from a specific peer
   * Public endpoint
   */
  app.get('/peers/:peerId/offers', async (c) => {
    try {
      const peerId = c.req.param('peerId');
      const offers = await storage.getOffersByPeerId(peerId);

      // Collect unique topics
      const topicsSet = new Set<string>();
      offers.forEach(o => o.topics.forEach(t => topicsSet.add(t)));

      return c.json({
        peerId,
        offers: offers.map(o => ({
          id: o.id,
          sdp: o.sdp,
          topics: o.topics,
          expiresAt: o.expiresAt,
          lastSeen: o.lastSeen,
          hasSecret: !!o.secret,  // Indicate if secret is required without exposing it
          info: o.info  // Public info field
        })),
        topics: Array.from(topicsSet)
      }, 200);
    } catch (err) {
      console.error('Error fetching peer offers:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/mine
   * List all offers owned by authenticated peer
   * Requires authentication
   */
  app.get('/offers/mine', authMiddleware, async (c) => {
    try {
      const peerId = getAuthenticatedPeerId(c);
      const offers = await storage.getOffersByPeerId(peerId);

      return c.json({
        peerId,
        offers: offers.map(o => ({
          id: o.id,
          sdp: o.sdp,
          topics: o.topics,
          createdAt: o.createdAt,
          expiresAt: o.expiresAt,
          lastSeen: o.lastSeen,
          secret: o.secret,  // Owner can see the secret
          info: o.info,  // Owner can see the info
          answererPeerId: o.answererPeerId,
          answeredAt: o.answeredAt
        }))
      }, 200);
    } catch (err) {
      console.error('Error fetching own offers:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * DELETE /offers/:offerId
   * Delete a specific offer
   * Requires authentication and ownership
   */
  app.delete('/offers/:offerId', authMiddleware, async (c) => {
    try {
      const offerId = c.req.param('offerId');
      const peerId = getAuthenticatedPeerId(c);

      const deleted = await storage.deleteOffer(offerId, peerId);

      if (!deleted) {
        return c.json({ error: 'Offer not found or not authorized' }, 404);
      }

      return c.json({ deleted: true }, 200);
    } catch (err) {
      console.error('Error deleting offer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /offers/:offerId/answer
   * Answer a specific offer (locks it to answerer)
   * Requires authentication
   */
  app.post('/offers/:offerId/answer', authMiddleware, async (c) => {
    try {
      const offerId = c.req.param('offerId');
      const peerId = getAuthenticatedPeerId(c);
      const body = await c.req.json();
      const { sdp, secret } = body;

      if (!sdp || typeof sdp !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: sdp' }, 400);
      }

      if (sdp.length > 65536) {
        return c.json({ error: 'SDP must be 64KB or less' }, 400);
      }

      // Validate secret if provided
      if (secret !== undefined && typeof secret !== 'string') {
        return c.json({ error: 'Secret must be a string' }, 400);
      }

      const result = await storage.answerOffer(offerId, peerId, sdp, secret);

      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({
        offerId,
        answererId: peerId,
        answeredAt: Date.now()
      }, 200);
    } catch (err) {
      console.error('Error answering offer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/answers
   * Poll for answers to all of authenticated peer's offers
   * Requires authentication (offerer)
   */
  app.get('/offers/answers', authMiddleware, async (c) => {
    try {
      const peerId = getAuthenticatedPeerId(c);
      const offers = await storage.getAnsweredOffers(peerId);

      return c.json({
        answers: offers.map(o => ({
          offerId: o.id,
          answererId: o.answererPeerId,
          sdp: o.answerSdp,
          answeredAt: o.answeredAt,
          topics: o.topics
        }))
      }, 200);
    } catch (err) {
      console.error('Error fetching answers:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /offers/:offerId/ice-candidates
   * Post ICE candidates for an offer
   * Requires authentication (must be offerer or answerer)
   */
  app.post('/offers/:offerId/ice-candidates', authMiddleware, async (c) => {
    try {
      const offerId = c.req.param('offerId');
      const peerId = getAuthenticatedPeerId(c);
      const body = await c.req.json();
      const { candidates } = body;

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return c.json({ error: 'Missing or invalid required parameter: candidates (must be non-empty array)' }, 400);
      }

      // Verify offer exists and caller is offerer or answerer
      const offer = await storage.getOfferById(offerId);
      if (!offer) {
        return c.json({ error: 'Offer not found or expired' }, 404);
      }

      let role: 'offerer' | 'answerer';
      if (offer.peerId === peerId) {
        role = 'offerer';
      } else if (offer.answererPeerId === peerId) {
        role = 'answerer';
      } else {
        return c.json({ error: 'Not authorized to post ICE candidates for this offer' }, 403);
      }

      const added = await storage.addIceCandidates(offerId, peerId, role, candidates);

      return c.json({
        offerId,
        candidatesAdded: added
      }, 200);
    } catch (err) {
      console.error('Error adding ICE candidates:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/:offerId/ice-candidates
   * Poll for ICE candidates from the other peer
   * Requires authentication (must be offerer or answerer)
   */
  app.get('/offers/:offerId/ice-candidates', authMiddleware, async (c) => {
    try {
      const offerId = c.req.param('offerId');
      const peerId = getAuthenticatedPeerId(c);
      const sinceParam = c.req.query('since');

      const since = sinceParam ? parseInt(sinceParam, 10) : undefined;

      // Verify offer exists and caller is offerer or answerer
      const offer = await storage.getOfferById(offerId);
      if (!offer) {
        return c.json({ error: 'Offer not found or expired' }, 404);
      }

      let targetRole: 'offerer' | 'answerer';
      if (offer.peerId === peerId) {
        // Offerer wants answerer's candidates
        targetRole = 'answerer';
        console.log(`[ICE GET] Offerer ${peerId} requesting answerer ICE candidates for offer ${offerId}, since=${since}, answererPeerId=${offer.answererPeerId}`);
      } else if (offer.answererPeerId === peerId) {
        // Answerer wants offerer's candidates
        targetRole = 'offerer';
        console.log(`[ICE GET] Answerer ${peerId} requesting offerer ICE candidates for offer ${offerId}, since=${since}, offererPeerId=${offer.peerId}`);
      } else {
        return c.json({ error: 'Not authorized to view ICE candidates for this offer' }, 403);
      }

      const candidates = await storage.getIceCandidates(offerId, targetRole, since);
      console.log(`[ICE GET] Found ${candidates.length} candidates for offer ${offerId}, targetRole=${targetRole}, since=${since}`);

      return c.json({
        offerId,
        candidates: candidates.map(c => ({
          candidate: c.candidate,
          peerId: c.peerId,
          role: c.role,
          createdAt: c.createdAt
        }))
      }, 200);
    } catch (err) {
      console.error('Error fetching ICE candidates:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return app;
}
