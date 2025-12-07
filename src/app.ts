import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import { createAuthMiddleware, getAuthenticatedPeerId } from './middleware/auth.ts';
import { generatePeerId, encryptPeerId, validateUsernameClaim, validateServicePublish, validateServiceFqn, parseServiceFqn, isVersionCompatible } from './crypto.ts';
import type { Context } from 'hono';

/**
 * Creates the Hono application with username and service-based WebRTC signaling
 * RESTful API design - v0.11.0
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
   * Register a new peer
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

  /**
   * GET /users/:username/services/:fqn
   * Get service by username and FQN with semver-compatible matching
   */
  app.get('/users/:username/services/:fqn', async (c) => {
    try {
      const username = c.req.param('username');
      const serviceFqn = decodeURIComponent(c.req.param('fqn'));

      // Parse the requested FQN
      const parsed = parseServiceFqn(serviceFqn);
      if (!parsed) {
        return c.json({ error: 'Invalid service FQN format' }, 400);
      }

      const { serviceName, version: requestedVersion } = parsed;

      // Find all services with matching service name
      const matchingServices = await storage.findServicesByName(username, serviceName);

      if (matchingServices.length === 0) {
        return c.json({ error: 'Service not found' }, 404);
      }

      // Filter to compatible versions
      const compatibleServices = matchingServices.filter(service => {
        const serviceParsed = parseServiceFqn(service.serviceFqn);
        if (!serviceParsed) return false;
        return isVersionCompatible(requestedVersion, serviceParsed.version);
      });

      if (compatibleServices.length === 0) {
        return c.json({
          error: 'No compatible version found',
          message: `Requested ${serviceFqn}, but no compatible versions available`
        }, 404);
      }

      // Use the first compatible service (most recently created)
      const service = compatibleServices[0];

      // Get the UUID for this service
      const uuid = await storage.queryService(username, service.serviceFqn);

      if (!uuid) {
        return c.json({ error: 'Service index not found' }, 500);
      }

      // Get all offers for this service
      const serviceOffers = await storage.getOffersForService(service.id);

      if (serviceOffers.length === 0) {
        return c.json({ error: 'No offers found for this service' }, 404);
      }

      // Find an unanswered offer
      const availableOffer = serviceOffers.find(offer => !offer.answererPeerId);

      if (!availableOffer) {
        return c.json({
          error: 'No available offers',
          message: 'All offers from this service are currently in use. Please try again later.'
        }, 503);
      }

      return c.json({
        uuid: uuid,
        serviceId: service.id,
        username: service.username,
        serviceFqn: service.serviceFqn,
        offerId: availableOffer.id,
        sdp: availableOffer.sdp,
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
   * POST /users/:username/services
   * Publish a service with one or more offers (RESTful endpoint)
   */
  app.post('/users/:username/services', authMiddleware, async (c) => {
    let serviceFqn: string | undefined;
    let createdOffers: any[] = [];

    try {
      const username = c.req.param('username');
      const body = await c.req.json();
      serviceFqn = body.serviceFqn;
      const { offers, ttl, isPublic, metadata, signature, message } = body;

      if (!serviceFqn || !offers || !Array.isArray(offers) || offers.length === 0) {
        return c.json({ error: 'Missing required parameters: serviceFqn, offers (must be non-empty array)' }, 400);
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
      const peerId = getAuthenticatedPeerId(c);
      const offerTtl = Math.min(
        Math.max(ttl || config.offerDefaultTtl, config.offerMinTtl),
        config.offerMaxTtl
      );
      const expiresAt = Date.now() + offerTtl;

      // Prepare offer requests
      const offerRequests = offers.map(offer => ({
        peerId,
        sdp: offer.sdp,
        expiresAt
      }));

      // Create service with offers
      const result = await storage.createService({
        username,
        serviceFqn,
        expiresAt,
        isPublic: isPublic || false,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
        offers: offerRequests
      });

      createdOffers = result.offers;

      // Return full service details with all offers
      return c.json({
        uuid: result.indexUuid,
        serviceFqn: serviceFqn,
        username: username,
        serviceId: result.service.id,
        offers: result.offers.map(o => ({
          offerId: o.id,
          sdp: o.sdp,
          createdAt: o.createdAt,
          expiresAt: o.expiresAt
        })),
        isPublic: result.service.isPublic,
        metadata: metadata,
        createdAt: result.service.createdAt,
        expiresAt: result.service.expiresAt
      }, 201);
    } catch (err) {
      console.error('Error creating service:', err);
      console.error('Error details:', {
        message: (err as Error).message,
        stack: (err as Error).stack,
        username: c.req.param('username'),
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
   * DELETE /users/:username/services/:fqn
   * Delete a service by username and FQN (RESTful)
   */
  app.delete('/users/:username/services/:fqn', authMiddleware, async (c) => {
    try {
      const username = c.req.param('username');
      const serviceFqn = decodeURIComponent(c.req.param('fqn'));

      // Find service by username and FQN
      const uuid = await storage.queryService(username, serviceFqn);
      if (!uuid) {
        return c.json({ error: 'Service not found' }, 404);
      }

      const service = await storage.getServiceByUuid(uuid);
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

  // ===== Service Management (Legacy - for UUID-based access) =====

  /**
   * GET /services/:uuid
   * Get service details by index UUID (kept for privacy)
   */
  app.get('/services/:uuid', async (c) => {
    try {
      const uuid = c.req.param('uuid');

      const service = await storage.getServiceByUuid(uuid);

      if (!service) {
        return c.json({ error: 'Service not found' }, 404);
      }

      // Get all offers for this service
      const serviceOffers = await storage.getOffersForService(service.id);

      if (serviceOffers.length === 0) {
        return c.json({ error: 'No offers found for this service' }, 404);
      }

      // Find an unanswered offer
      const availableOffer = serviceOffers.find(offer => !offer.answererPeerId);

      if (!availableOffer) {
        return c.json({
          error: 'No available offers',
          message: 'All offers from this service are currently in use. Please try again later.'
        }, 503);
      }

      return c.json({
        uuid: uuid,
        serviceId: service.id,
        username: service.username,
        serviceFqn: service.serviceFqn,
        offerId: availableOffer.id,
        sdp: availableOffer.sdp,
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

  // ===== Service-Based WebRTC Signaling =====

  /**
   * POST /services/:uuid/answer
   * Answer a service offer
   */
  app.post('/services/:uuid/answer', authMiddleware, async (c) => {
    try {
      const uuid = c.req.param('uuid');
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

      // Get the service by UUID
      const service = await storage.getServiceByUuid(uuid);
      if (!service) {
        return c.json({ error: 'Service not found' }, 404);
      }

      // Get available offer from service
      const serviceOffers = await storage.getOffersForService(service.id);
      const availableOffer = serviceOffers.find(offer => !offer.answererPeerId);

      if (!availableOffer) {
        return c.json({ error: 'No available offers' }, 503);
      }

      const answererPeerId = getAuthenticatedPeerId(c);

      const result = await storage.answerOffer(availableOffer.id, answererPeerId, sdp);

      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({
        success: true,
        offerId: availableOffer.id
      }, 200);
    } catch (err) {
      console.error('Error answering service:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /services/:uuid/answer
   * Get answer for a service (offerer polls this)
   */
  app.get('/services/:uuid/answer', authMiddleware, async (c) => {
    try {
      const uuid = c.req.param('uuid');
      const peerId = getAuthenticatedPeerId(c);

      // Get the service by UUID
      const service = await storage.getServiceByUuid(uuid);
      if (!service) {
        return c.json({ error: 'Service not found' }, 404);
      }

      // Get offers for this service owned by the requesting peer
      const serviceOffers = await storage.getOffersForService(service.id);
      const myOffer = serviceOffers.find(offer => offer.peerId === peerId && offer.answererPeerId);

      if (!myOffer || !myOffer.answerSdp) {
        return c.json({ error: 'Offer not yet answered' }, 404);
      }

      return c.json({
        offerId: myOffer.id,
        answererId: myOffer.answererPeerId,
        sdp: myOffer.answerSdp,
        answeredAt: myOffer.answeredAt
      }, 200);
    } catch (err) {
      console.error('Error getting service answer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /services/:uuid/ice-candidates
   * Add ICE candidates for a service
   */
  app.post('/services/:uuid/ice-candidates', authMiddleware, async (c) => {
    try {
      const uuid = c.req.param('uuid');
      const body = await c.req.json();
      const { candidates, offerId } = body;

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return c.json({ error: 'Missing or invalid required parameter: candidates' }, 400);
      }

      const peerId = getAuthenticatedPeerId(c);

      // Get the service by UUID
      const service = await storage.getServiceByUuid(uuid);
      if (!service) {
        return c.json({ error: 'Service not found' }, 404);
      }

      // If offerId is provided, use it; otherwise find the peer's offer
      let targetOfferId = offerId;
      if (!targetOfferId) {
        const serviceOffers = await storage.getOffersForService(service.id);
        const myOffer = serviceOffers.find(offer =>
          offer.peerId === peerId || offer.answererPeerId === peerId
        );
        if (!myOffer) {
          return c.json({ error: 'No offer found for this peer' }, 404);
        }
        targetOfferId = myOffer.id;
      }

      // Get offer to determine role
      const offer = await storage.getOfferById(targetOfferId);
      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      // Determine role
      const role = offer.peerId === peerId ? 'offerer' : 'answerer';

      const count = await storage.addIceCandidates(targetOfferId, peerId, role, candidates);

      return c.json({ count, offerId: targetOfferId }, 200);
    } catch (err) {
      console.error('Error adding ICE candidates to service:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /services/:uuid/ice-candidates
   * Get ICE candidates for a service
   */
  app.get('/services/:uuid/ice-candidates', authMiddleware, async (c) => {
    try {
      const uuid = c.req.param('uuid');
      const since = c.req.query('since');
      const offerId = c.req.query('offerId');
      const peerId = getAuthenticatedPeerId(c);

      // Get the service by UUID
      const service = await storage.getServiceByUuid(uuid);
      if (!service) {
        return c.json({ error: 'Service not found' }, 404);
      }

      // If offerId is provided, use it; otherwise find the peer's offer
      let targetOfferId = offerId;
      if (!targetOfferId) {
        const serviceOffers = await storage.getOffersForService(service.id);
        const myOffer = serviceOffers.find(offer =>
          offer.peerId === peerId || offer.answererPeerId === peerId
        );
        if (!myOffer) {
          return c.json({ error: 'No offer found for this peer' }, 404);
        }
        targetOfferId = myOffer.id;
      }

      // Get offer to determine role
      const offer = await storage.getOfferById(targetOfferId);
      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      // Get candidates for opposite role
      const targetRole = offer.peerId === peerId ? 'answerer' : 'offerer';
      const sinceTimestamp = since ? parseInt(since, 10) : undefined;

      const candidates = await storage.getIceCandidates(targetOfferId, targetRole, sinceTimestamp);

      return c.json({
        candidates: candidates.map(c => ({
          candidate: c.candidate,
          createdAt: c.createdAt
        })),
        offerId: targetOfferId
      }, 200);
    } catch (err) {
      console.error('Error getting ICE candidates for service:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return app;
}
