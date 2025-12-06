import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import { createAuthMiddleware, getAuthenticatedPeerId } from './middleware/auth.ts';
import { generatePeerId, encryptPeerId, validateUsernameClaim, validateServicePublish, validateServiceFqn } from './crypto.ts';
import type { Context } from 'hono';

/**
 * Creates the Hono application with username and service-based WebRTC signaling
 */
export function createApp(storage: Storage, config: Config) {
  const app = new Hono();

  // Create auth middleware
  const authMiddleware = createAuthMiddleware(config.authSecret);

  // Enable CORS
  app.use('/*', cors({
    origin: (origin) => {
      if (config.corsOrigins.length === 1 && config.corsOrigins[0] === '*') {
        return origin;
      }
      if (config.corsOrigins.includes(origin)) {
        return origin;
      }
      return config.corsOrigins[0];
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Origin', 'Authorization'],
    exposeHeaders: ['Content-Type'],
    maxAge: 600,
    credentials: true,
  }));

  // ===== General Endpoints =====

  /**
   * GET /
   * Returns server information
   */
  app.get('/', (c) => {
    return c.json({
      version: config.version,
      name: 'Rondevu',
      description: 'DNS-like WebRTC signaling with username claiming and service discovery'
    });
  });

  /**
   * GET /health
   * Health check endpoint
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
   * Register a new peer (still needed for peer ID generation)
   */
  app.post('/register', async (c) => {
    try {
      const peerId = generatePeerId();
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

  // ===== Username Management =====

  /**
   * POST /usernames/claim
   * Claim a username with cryptographic proof
   */
  app.post('/usernames/claim', async (c) => {
    try {
      const body = await c.req.json();
      const { username, publicKey, signature, message } = body;

      if (!username || !publicKey || !signature || !message) {
        return c.json({ error: 'Missing required parameters: username, publicKey, signature, message' }, 400);
      }

      // Validate claim
      const validation = await validateUsernameClaim(username, publicKey, signature, message);
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }

      // Attempt to claim username
      try {
        const claimed = await storage.claimUsername({
          username,
          publicKey,
          signature,
          message
        });

        return c.json({
          username: claimed.username,
          claimedAt: claimed.claimedAt,
          expiresAt: claimed.expiresAt
        }, 200);
      } catch (err: any) {
        if (err.message?.includes('already claimed')) {
          return c.json({ error: 'Username already claimed by different public key' }, 409);
        }
        throw err;
      }
    } catch (err) {
      console.error('Error claiming username:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /usernames/:username
   * Check if username is available or get claim info
   */
  app.get('/usernames/:username', async (c) => {
    try {
      const username = c.req.param('username');

      const claimed = await storage.getUsername(username);

      if (!claimed) {
        return c.json({
          username,
          available: true
        }, 200);
      }

      return c.json({
        username: claimed.username,
        available: false,
        claimedAt: claimed.claimedAt,
        expiresAt: claimed.expiresAt,
        publicKey: claimed.publicKey
      }, 200);
    } catch (err) {
      console.error('Error checking username:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /usernames/:username/services
   * List services for a username (privacy-preserving)
   */
  app.get('/usernames/:username/services', async (c) => {
    try {
      const username = c.req.param('username');

      const services = await storage.listServicesForUsername(username);

      return c.json({
        username,
        services
      }, 200);
    } catch (err) {
      console.error('Error listing services:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ===== Service Management =====

  /**
   * POST /services
   * Publish a service
   */
  app.post('/services', authMiddleware, async (c) => {
    let username: string | undefined;
    let serviceFqn: string | undefined;
    let offers: any[] = [];

    try {
      const body = await c.req.json();
      ({ username, serviceFqn } = body);
      const { sdp, ttl, isPublic, metadata, signature, message } = body;

      if (!username || !serviceFqn || !sdp) {
        return c.json({ error: 'Missing required parameters: username, serviceFqn, sdp' }, 400);
      }

      // Validate service FQN
      const fqnValidation = validateServiceFqn(serviceFqn);
      if (!fqnValidation.valid) {
        return c.json({ error: fqnValidation.error }, 400);
      }

      // Verify username ownership (signature required)
      if (!signature || !message) {
        return c.json({ error: 'Missing signature or message for username verification' }, 400);
      }

      const usernameRecord = await storage.getUsername(username);
      if (!usernameRecord) {
        return c.json({ error: 'Username not claimed' }, 404);
      }

      // Verify signature matches username's public key
      const signatureValidation = await validateServicePublish(username, serviceFqn, usernameRecord.publicKey, signature, message);
      if (!signatureValidation.valid) {
        return c.json({ error: 'Invalid signature for username' }, 403);
      }

      // Delete existing service if one exists (upsert behavior)
      const existingUuid = await storage.queryService(username, serviceFqn);
      if (existingUuid) {
        const existingService = await storage.getServiceByUuid(existingUuid);
        if (existingService) {
          await storage.deleteService(existingService.id, username);
        }
      }

      // Validate SDP
      if (typeof sdp !== 'string' || sdp.length === 0) {
        return c.json({ error: 'Invalid SDP' }, 400);
      }

      if (sdp.length > 64 * 1024) {
        return c.json({ error: 'SDP too large (max 64KB)' }, 400);
      }

      // Calculate expiry
      const peerId = getAuthenticatedPeerId(c);
      const offerTtl = Math.min(
        Math.max(ttl || config.offerDefaultTtl, config.offerMinTtl),
        config.offerMaxTtl
      );
      const expiresAt = Date.now() + offerTtl;

      // Create offer first
      offers = await storage.createOffers([{
        peerId,
        sdp,
        expiresAt
      }]);

      if (offers.length === 0) {
        return c.json({ error: 'Failed to create offer' }, 500);
      }

      const offer = offers[0];

      // Create service
      const result = await storage.createService({
        username,
        serviceFqn,
        offerId: offer.id,
        expiresAt,
        isPublic: isPublic || false,
        metadata: metadata ? JSON.stringify(metadata) : undefined
      });

      return c.json({
        serviceId: result.service.id,
        uuid: result.indexUuid,
        offerId: offer.id,
        expiresAt: result.service.expiresAt
      }, 201);
    } catch (err) {
      console.error('Error creating service:', err);
      console.error('Error details:', {
        message: (err as Error).message,
        stack: (err as Error).stack,
        username,
        serviceFqn,
        offerId: offers[0]?.id
      });
      return c.json({
        error: 'Internal server error',
        details: (err as Error).message
      }, 500);
    }
  });

  /**
   * GET /services/:uuid
   * Get service details by index UUID
   */
  app.get('/services/:uuid', async (c) => {
    try {
      const uuid = c.req.param('uuid');

      const service = await storage.getServiceByUuid(uuid);

      if (!service) {
        return c.json({ error: 'Service not found' }, 404);
      }

      // Get associated offer
      const offer = await storage.getOfferById(service.offerId);

      if (!offer) {
        return c.json({ error: 'Associated offer not found' }, 404);
      }

      return c.json({
        serviceId: service.id,
        username: service.username,
        serviceFqn: service.serviceFqn,
        offerId: service.offerId,
        sdp: offer.sdp,
        isPublic: service.isPublic,
        metadata: service.metadata ? JSON.parse(service.metadata) : undefined,
        createdAt: service.createdAt,
        expiresAt: service.expiresAt
      }, 200);
    } catch (err) {
      console.error('Error getting service:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * DELETE /services/:serviceId
   * Delete a service (requires ownership)
   */
  app.delete('/services/:serviceId', authMiddleware, async (c) => {
    try {
      const serviceId = c.req.param('serviceId');
      const body = await c.req.json();
      const { username } = body;

      if (!username) {
        return c.json({ error: 'Missing required parameter: username' }, 400);
      }

      const deleted = await storage.deleteService(serviceId, username);

      if (!deleted) {
        return c.json({ error: 'Service not found or not owned by this username' }, 404);
      }

      return c.json({ success: true }, 200);
    } catch (err) {
      console.error('Error deleting service:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /index/:username/query
   * Query service by FQN (returns UUID)
   */
  app.post('/index/:username/query', async (c) => {
    try {
      const username = c.req.param('username');
      const body = await c.req.json();
      const { serviceFqn } = body;

      if (!serviceFqn) {
        return c.json({ error: 'Missing required parameter: serviceFqn' }, 400);
      }

      const uuid = await storage.queryService(username, serviceFqn);

      if (!uuid) {
        return c.json({ error: 'Service not found' }, 404);
      }

      return c.json({
        uuid,
        allowed: true
      }, 200);
    } catch (err) {
      console.error('Error querying service:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ===== Offer Management (Core WebRTC) =====

  /**
   * POST /offers
   * Create offers (direct, no service - for testing/advanced users)
   */
  app.post('/offers', authMiddleware, async (c) => {
    try {
      const body = await c.req.json();
      const { offers } = body;

      if (!Array.isArray(offers) || offers.length === 0) {
        return c.json({ error: 'Missing or invalid required parameter: offers (must be non-empty array)' }, 400);
      }

      if (offers.length > config.maxOffersPerRequest) {
        return c.json({ error: `Too many offers (max ${config.maxOffersPerRequest})` }, 400);
      }

      const peerId = getAuthenticatedPeerId(c);

      // Validate and prepare offers
      const validated = offers.map((offer: any) => {
        const { sdp, ttl, secret } = offer;

        if (typeof sdp !== 'string' || sdp.length === 0) {
          throw new Error('Invalid SDP in offer');
        }

        if (sdp.length > 64 * 1024) {
          throw new Error('SDP too large (max 64KB)');
        }

        const offerTtl = Math.min(
          Math.max(ttl || config.offerDefaultTtl, config.offerMinTtl),
          config.offerMaxTtl
        );

        return {
          peerId,
          sdp,
          expiresAt: Date.now() + offerTtl,
          secret: secret ? String(secret).substring(0, 128) : undefined
        };
      });

      const created = await storage.createOffers(validated);

      return c.json({
        offers: created.map(offer => ({
          id: offer.id,
          peerId: offer.peerId,
          expiresAt: offer.expiresAt,
          createdAt: offer.createdAt,
          hasSecret: !!offer.secret
        }))
      }, 201);
    } catch (err: any) {
      console.error('Error creating offers:', err);
      return c.json({ error: err.message || 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/mine
   * Get authenticated peer's offers
   */
  app.get('/offers/mine', authMiddleware, async (c) => {
    try {
      const peerId = getAuthenticatedPeerId(c);
      const offers = await storage.getOffersByPeerId(peerId);

      return c.json({
        offers: offers.map(offer => ({
          id: offer.id,
          sdp: offer.sdp,
          createdAt: offer.createdAt,
          expiresAt: offer.expiresAt,
          lastSeen: offer.lastSeen,
          hasSecret: !!offer.secret,
          answererPeerId: offer.answererPeerId,
          answered: !!offer.answererPeerId
        }))
      }, 200);
    } catch (err) {
      console.error('Error getting offers:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * DELETE /offers/:offerId
   * Delete an offer
   */
  app.delete('/offers/:offerId', authMiddleware, async (c) => {
    try {
      const offerId = c.req.param('offerId');
      const peerId = getAuthenticatedPeerId(c);

      const deleted = await storage.deleteOffer(offerId, peerId);

      if (!deleted) {
        return c.json({ error: 'Offer not found or not owned by this peer' }, 404);
      }

      return c.json({ success: true }, 200);
    } catch (err) {
      console.error('Error deleting offer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /offers/:offerId/answer
   * Answer an offer
   */
  app.post('/offers/:offerId/answer', authMiddleware, async (c) => {
    try {
      const offerId = c.req.param('offerId');
      const body = await c.req.json();
      const { sdp, secret } = body;

      if (!sdp) {
        return c.json({ error: 'Missing required parameter: sdp' }, 400);
      }

      if (typeof sdp !== 'string' || sdp.length === 0) {
        return c.json({ error: 'Invalid SDP' }, 400);
      }

      if (sdp.length > 64 * 1024) {
        return c.json({ error: 'SDP too large (max 64KB)' }, 400);
      }

      const answererPeerId = getAuthenticatedPeerId(c);

      const result = await storage.answerOffer(offerId, answererPeerId, sdp, secret);

      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ success: true }, 200);
    } catch (err) {
      console.error('Error answering offer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/answers
   * Get answers for authenticated peer's offers
   */
  app.get('/offers/answers', authMiddleware, async (c) => {
    try {
      const peerId = getAuthenticatedPeerId(c);
      const offers = await storage.getAnsweredOffers(peerId);

      return c.json({
        answers: offers.map(offer => ({
          offerId: offer.id,
          answererId: offer.answererPeerId,
          sdp: offer.answerSdp,
          answeredAt: offer.answeredAt
        }))
      }, 200);
    } catch (err) {
      console.error('Error getting answers:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ===== ICE Candidate Exchange =====

  /**
   * POST /offers/:offerId/ice-candidates
   * Add ICE candidates for an offer
   */
  app.post('/offers/:offerId/ice-candidates', authMiddleware, async (c) => {
    try {
      const offerId = c.req.param('offerId');
      const body = await c.req.json();
      const { candidates } = body;

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return c.json({ error: 'Missing or invalid required parameter: candidates' }, 400);
      }

      const peerId = getAuthenticatedPeerId(c);

      // Get offer to determine role
      const offer = await storage.getOfferById(offerId);
      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      // Determine role
      const role = offer.peerId === peerId ? 'offerer' : 'answerer';

      const count = await storage.addIceCandidates(offerId, peerId, role, candidates);

      return c.json({ count }, 200);
    } catch (err) {
      console.error('Error adding ICE candidates:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/:offerId/ice-candidates
   * Get ICE candidates for an offer
   */
  app.get('/offers/:offerId/ice-candidates', authMiddleware, async (c) => {
    try {
      const offerId = c.req.param('offerId');
      const since = c.req.query('since');
      const peerId = getAuthenticatedPeerId(c);

      // Get offer to determine role
      const offer = await storage.getOfferById(offerId);
      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      // Get candidates for opposite role
      const targetRole = offer.peerId === peerId ? 'answerer' : 'offerer';
      const sinceTimestamp = since ? parseInt(since, 10) : undefined;

      const candidates = await storage.getIceCandidates(offerId, targetRole, sinceTimestamp);

      return c.json({
        candidates: candidates.map(c => ({
          candidate: c.candidate,
          createdAt: c.createdAt
        }))
      }, 200);
    } catch (err) {
      console.error('Error getting ICE candidates:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return app;
}
