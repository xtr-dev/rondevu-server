import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import { createAuthMiddleware, getAuthenticatedUsername } from './middleware/auth.ts';
import { validateUsernameClaim, validateServicePublish, validateServiceFqn, parseServiceFqn, isVersionCompatible } from './crypto.ts';
import type { Context } from 'hono';

/**
 * Creates the Hono application with username and service-based WebRTC signaling
 * RESTful API design - v0.11.0
 */
export function createApp(storage: Storage, config: Config) {
  const app = new Hono();

  // Create auth middleware
  const authMiddleware = createAuthMiddleware(storage);

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


  // ===== User Management (RESTful) =====

  /**
   * GET /users/:username
   * Check if username is available or get claim info
   */
  app.get('/users/:username', async (c) => {
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
   * POST /users/:username
   * Claim a username with cryptographic proof
   */
  app.post('/users/:username', async (c) => {
    try {
      const username = c.req.param('username');
      const body = await c.req.json();
      const { publicKey, signature, message } = body;

      if (!publicKey || !signature || !message) {
        return c.json({ error: 'Missing required parameters: publicKey, signature, message' }, 400);
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
        }, 201);
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

  // ===== Service Discovery and Management =====

  /**
   * GET /services/:fqn
   * Get service by FQN with optional discovery
   * Supports three modes:
   * 1. Direct lookup: /services/chat:1.0.0@alice - Returns specific user's offer
   * 2. Random discovery: /services/chat:1.0.0 - Returns random available offer
   * 3. Paginated discovery: /services/chat:1.0.0?limit=10&offset=0 - Returns array of available offers
   */
  app.get('/services/:fqn', async (c) => {
    try {
      const serviceFqn = decodeURIComponent(c.req.param('fqn'));
      const limit = c.req.query('limit');
      const offset = c.req.query('offset');

      // Parse the requested FQN
      const parsed = parseServiceFqn(serviceFqn);
      if (!parsed) {
        return c.json({ error: 'Invalid service FQN format. Use service:version or service:version@username' }, 400);
      }

      const { serviceName, version, username } = parsed;

      // Mode 1: Direct lookup with username
      if (username) {
        // Find service by exact FQN
        const service = await storage.getServiceByFqn(serviceFqn);

        if (!service) {
          return c.json({ error: 'Service not found' }, 404);
        }

        // Get available offer from this service
        const serviceOffers = await storage.getOffersForService(service.id);
        const availableOffer = serviceOffers.find(offer => !offer.answererUsername);

        if (!availableOffer) {
          return c.json({
            error: 'No available offers',
            message: 'All offers from this service are currently in use.'
          }, 503);
        }

        return c.json({
          serviceId: service.id,
          username: service.username,
          serviceFqn: service.serviceFqn,
          offerId: availableOffer.id,
          sdp: availableOffer.sdp,
          createdAt: service.createdAt,
          expiresAt: service.expiresAt
        }, 200);
      }

      // Mode 2 & 3: Discovery without username
      if (limit || offset) {
        // Paginated discovery
        const limitNum = limit ? Math.min(parseInt(limit, 10), 100) : 10;
        const offsetNum = offset ? parseInt(offset, 10) : 0;

        const services = await storage.discoverServices(serviceName, version, limitNum, offsetNum);

        if (services.length === 0) {
          return c.json({
            error: 'No services found',
            message: `No available services found for ${serviceName}:${version}`
          }, 404);
        }

        // Get available offers for each service
        const servicesWithOffers = await Promise.all(
          services.map(async (service) => {
            const offers = await storage.getOffersForService(service.id);
            const availableOffer = offers.find(offer => !offer.answererUsername);
            return availableOffer ? {
              serviceId: service.id,
              username: service.username,
              serviceFqn: service.serviceFqn,
              offerId: availableOffer.id,
              sdp: availableOffer.sdp,
              createdAt: service.createdAt,
              expiresAt: service.expiresAt
            } : null;
          })
        );

        const availableServices = servicesWithOffers.filter(s => s !== null);

        return c.json({
          services: availableServices,
          count: availableServices.length,
          limit: limitNum,
          offset: offsetNum
        }, 200);
      } else {
        // Random discovery
        const service = await storage.getRandomService(serviceName, version);

        if (!service) {
          return c.json({
            error: 'No services found',
            message: `No available services found for ${serviceName}:${version}`
          }, 404);
        }

        // Get available offer
        const offers = await storage.getOffersForService(service.id);
        const availableOffer = offers.find(offer => !offer.answererUsername);

        if (!availableOffer) {
          return c.json({
            error: 'No available offers',
            message: 'Service found but no available offers.'
          }, 503);
        }

        return c.json({
          serviceId: service.id,
          username: service.username,
          serviceFqn: service.serviceFqn,
          offerId: availableOffer.id,
          sdp: availableOffer.sdp,
          createdAt: service.createdAt,
          expiresAt: service.expiresAt
        }, 200);
      }
    } catch (err) {
      console.error('Error getting service:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /services
   * Publish a service with one or more offers
   * Service FQN must include username: service:version@username
   */
  app.post('/services', authMiddleware, async (c) => {
    let serviceFqn: string | undefined;
    let createdOffers: any[] = [];

    try {
      const body = await c.req.json();
      serviceFqn = body.serviceFqn;
      const { offers, ttl, signature, message } = body;

      if (!serviceFqn || !offers || !Array.isArray(offers) || offers.length === 0) {
        return c.json({ error: 'Missing required parameters: serviceFqn, offers (must be non-empty array)' }, 400);
      }

      // Validate and parse service FQN
      const fqnValidation = validateServiceFqn(serviceFqn);
      if (!fqnValidation.valid) {
        return c.json({ error: fqnValidation.error }, 400);
      }

      const parsed = parseServiceFqn(serviceFqn);
      if (!parsed || !parsed.username) {
        return c.json({ error: 'Service FQN must include username (format: service:version@username)' }, 400);
      }

      const username = parsed.username;

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

      // Note: createService handles upsert behavior (deletes existing service if it exists)

      // Validate all offers
      for (const offer of offers) {
        if (!offer.sdp || typeof offer.sdp !== 'string' || offer.sdp.length === 0) {
          return c.json({ error: 'Invalid SDP in offers array' }, 400);
        }

        if (offer.sdp.length > 64 * 1024) {
          return c.json({ error: 'SDP too large (max 64KB)' }, 400);
        }
      }

      // Calculate expiry
      const authenticatedUsername = getAuthenticatedUsername(c);
      const offerTtl = Math.min(
        Math.max(ttl || config.offerDefaultTtl, config.offerMinTtl),
        config.offerMaxTtl
      );
      const expiresAt = Date.now() + offerTtl;

      // Prepare offer requests
      const offerRequests = offers.map(offer => ({
        username: authenticatedUsername,
        sdp: offer.sdp,
        expiresAt
      }));

      // Create service with offers
      const result = await storage.createService({
        serviceFqn,
        expiresAt,
        offers: offerRequests
      });

      createdOffers = result.offers;

      // Return full service details with all offers
      return c.json({
        serviceFqn: result.service.serviceFqn,
        username: result.service.username,
        serviceId: result.service.id,
        offers: result.offers.map(o => ({
          offerId: o.id,
          sdp: o.sdp,
          createdAt: o.createdAt,
          expiresAt: o.expiresAt
        })),
        createdAt: result.service.createdAt,
        expiresAt: result.service.expiresAt
      }, 201);
    } catch (err) {
      console.error('Error creating service:', err);
      console.error('Error details:', {
        message: (err as Error).message,
        stack: (err as Error).stack,
        serviceFqn,
        offerIds: createdOffers.map(o => o.id)
      });
      return c.json({
        error: 'Internal server error',
        details: (err as Error).message
      }, 500);
    }
  });

  /**
   * DELETE /services/:fqn
   * Delete a service by FQN (must include username)
   */
  app.delete('/services/:fqn', authMiddleware, async (c) => {
    try {
      const serviceFqn = decodeURIComponent(c.req.param('fqn'));

      // Parse and validate FQN
      const parsed = parseServiceFqn(serviceFqn);
      if (!parsed || !parsed.username) {
        return c.json({ error: 'Service FQN must include username (format: service:version@username)' }, 400);
      }

      const username = parsed.username;

      // Find service by FQN
      const service = await storage.getServiceByFqn(serviceFqn);
      if (!service) {
        return c.json({ error: 'Service not found' }, 404);
      }

      const deleted = await storage.deleteService(service.id, username);

      if (!deleted) {
        return c.json({ error: 'Service not found or not owned by this username' }, 404);
      }

      return c.json({ success: true }, 200);
    } catch (err) {
      console.error('Error deleting service:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ===== WebRTC Signaling (Offer-Specific) =====

  /**
   * POST /services/:fqn/offers/:offerId/answer
   * Answer a specific offer from a service
   */
  app.post('/services/:fqn/offers/:offerId/answer', authMiddleware, async (c) => {
    try {
      const serviceFqn = decodeURIComponent(c.req.param('fqn'));
      const offerId = c.req.param('offerId');
      const body = await c.req.json();
      const { sdp } = body;

      if (!sdp) {
        return c.json({ error: 'Missing required parameter: sdp' }, 400);
      }

      if (typeof sdp !== 'string' || sdp.length === 0) {
        return c.json({ error: 'Invalid SDP' }, 400);
      }

      if (sdp.length > 64 * 1024) {
        return c.json({ error: 'SDP too large (max 64KB)' }, 400);
      }

      // Verify offer exists
      const offer = await storage.getOfferById(offerId);
      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      const answererUsername = getAuthenticatedUsername(c);

      const result = await storage.answerOffer(offerId, answererUsername, sdp);

      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({
        success: true,
        offerId: offerId
      }, 200);
    } catch (err) {
      console.error('Error answering offer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /services/:fqn/offers/:offerId/answer
   * Get answer for a specific offer (offerer polls this)
   */
  app.get('/services/:fqn/offers/:offerId/answer', authMiddleware, async (c) => {
    try {
      const serviceFqn = decodeURIComponent(c.req.param('fqn'));
      const offerId = c.req.param('offerId');
      const username = getAuthenticatedUsername(c);

      // Get the offer
      const offer = await storage.getOfferById(offerId);
      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      // Verify ownership
      if (offer.username !== username) {
        return c.json({ error: 'Not authorized to access this offer' }, 403);
      }

      if (!offer.answerSdp) {
        return c.json({ error: 'Offer not yet answered' }, 404);
      }

      return c.json({
        offerId: offer.id,
        answererId: offer.answererUsername,
        sdp: offer.answerSdp,
        answeredAt: offer.answeredAt
      }, 200);
    } catch (err) {
      console.error('Error getting offer answer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/answered
   * Get all answered offers for the authenticated peer (efficient batch polling)
   */
  app.get('/offers/answered', authMiddleware, async (c) => {
    try {
      const username = getAuthenticatedUsername(c);
      const since = c.req.query('since');
      const sinceTimestamp = since ? parseInt(since, 10) : 0;

      const offers = await storage.getAnsweredOffers(username);

      // Filter by timestamp if provided
      const filteredOffers = since
        ? offers.filter(offer => offer.answeredAt && offer.answeredAt > sinceTimestamp)
        : offers;

      return c.json({
        offers: filteredOffers.map(offer => ({
          offerId: offer.id,
          serviceId: offer.serviceId,
          answererId: offer.answererUsername,
          sdp: offer.answerSdp,
          answeredAt: offer.answeredAt
        }))
      }, 200);
    } catch (err) {
      console.error('Error getting answered offers:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /offers/poll
   * Combined efficient polling endpoint for answers and ICE candidates
   * Returns all answered offers and ICE candidates for all peer's offers since timestamp
   */
  app.get('/offers/poll', authMiddleware, async (c) => {
    try {
      const username = getAuthenticatedUsername(c);
      const since = c.req.query('since');
      const sinceTimestamp = since ? parseInt(since, 10) : 0;

      // Get all answered offers
      const answeredOffers = await storage.getAnsweredOffers(username);
      const filteredAnswers = since
        ? answeredOffers.filter(offer => offer.answeredAt && offer.answeredAt > sinceTimestamp)
        : answeredOffers;

      // Get all user's offers
      const allOffers = await storage.getOffersByUsername(username);

      // For each offer, get ICE candidates from both sides
      const iceCandidatesByOffer: Record<string, any[]> = {};
      for (const offer of allOffers) {
        const allCandidates = [];

        // Get offerer ICE candidates (answerer polls for these, offerer can also see for debugging/sync)
        const offererCandidates = await storage.getIceCandidates(offer.id, 'offerer', sinceTimestamp);
        for (const c of offererCandidates) {
          allCandidates.push({
            candidate: c.candidate,
            role: 'offerer',
            username: c.username,
            createdAt: c.createdAt
          });
        }

        // Get answerer ICE candidates (offerer polls for these)
        const answererCandidates = await storage.getIceCandidates(offer.id, 'answerer', sinceTimestamp);
        for (const c of answererCandidates) {
          allCandidates.push({
            candidate: c.candidate,
            role: 'answerer',
            username: c.username,
            createdAt: c.createdAt
          });
        }

        if (allCandidates.length > 0) {
          iceCandidatesByOffer[offer.id] = allCandidates;
        }
      }

      return c.json({
        answers: filteredAnswers.map(offer => ({
          offerId: offer.id,
          serviceId: offer.serviceId,
          answererId: offer.answererUsername,
          sdp: offer.answerSdp,
          answeredAt: offer.answeredAt
        })),
        iceCandidates: iceCandidatesByOffer
      }, 200);
    } catch (err) {
      console.error('Error polling offers:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /services/:fqn/offers/:offerId/ice-candidates
   * Add ICE candidates for a specific offer
   */
  app.post('/services/:fqn/offers/:offerId/ice-candidates', authMiddleware, async (c) => {
    try {
      const serviceFqn = decodeURIComponent(c.req.param('fqn'));
      const offerId = c.req.param('offerId');
      const body = await c.req.json();
      const { candidates } = body;

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return c.json({ error: 'Missing or invalid required parameter: candidates' }, 400);
      }

      const username = getAuthenticatedUsername(c);

      // Get offer to determine role
      const offer = await storage.getOfferById(offerId);
      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      // Determine role (offerer or answerer)
      const role = offer.username === username ? 'offerer' : 'answerer';

      const count = await storage.addIceCandidates(offerId, username, role, candidates);

      return c.json({ count, offerId }, 200);
    } catch (err) {
      console.error('Error adding ICE candidates:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /services/:fqn/offers/:offerId/ice-candidates
   * Get ICE candidates for a specific offer
   */
  app.get('/services/:fqn/offers/:offerId/ice-candidates', authMiddleware, async (c) => {
    try {
      const serviceFqn = decodeURIComponent(c.req.param('fqn'));
      const offerId = c.req.param('offerId');
      const since = c.req.query('since');
      const username = getAuthenticatedUsername(c);

      // Get offer to determine role
      const offer = await storage.getOfferById(offerId);
      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      // Get candidates for opposite role
      const targetRole = offer.username === username ? 'answerer' : 'offerer';
      const sinceTimestamp = since ? parseInt(since, 10) : undefined;

      const candidates = await storage.getIceCandidates(offerId, targetRole, sinceTimestamp);

      return c.json({
        candidates: candidates.map(c => ({
          candidate: c.candidate,
          createdAt: c.createdAt
        })),
        offerId
      }, 200);
    } catch (err) {
      console.error('Error getting ICE candidates:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return app;
}
