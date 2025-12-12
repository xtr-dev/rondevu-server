import { Context } from 'hono';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import {
  validateUsernameClaim,
  validateServicePublish,
  validateServiceFqn,
  parseServiceFqn,
  isVersionCompatible,
  verifyEd25519Signature,
  validateAuthMessage,
  validateUsername,
} from './crypto.ts';

/**
 * RPC request format
 */
export interface RpcRequest {
  method: string;
  message: string;
  signature: string;
  publicKey?: string; // Optional: for auto-claiming usernames
  params?: any;
}

/**
 * RPC response format
 */
export interface RpcResponse {
  success: boolean;
  result?: any;
  error?: string;
}

/**
 * RPC method handler
 */
type RpcHandler = (
  params: any,
  message: string,
  signature: string,
  publicKey: string | undefined,
  storage: Storage,
  config: Config
) => Promise<any>;

/**
 * Verify authentication for a method call
 * Automatically claims username if it doesn't exist
 */
async function verifyAuth(
  username: string,
  message: string,
  signature: string,
  publicKey: string | undefined,
  storage: Storage
): Promise<{ valid: boolean; error?: string }> {
  // Get username record to fetch public key
  let usernameRecord = await storage.getUsername(username);

  // Auto-claim username if it doesn't exist
  if (!usernameRecord) {
    if (!publicKey) {
      return {
        valid: false,
        error: `Username "${username}" is not claimed and no public key provided for auto-claim.`,
      };
    }

    // Validate username format before claiming
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return usernameValidation;
    }

    // Verify signature against the current message (not a claim message)
    const signatureValid = await verifyEd25519Signature(publicKey, signature, message);
    if (!signatureValid) {
      return { valid: false, error: 'Invalid signature for auto-claim' };
    }

    // Auto-claim the username
    const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000; // 365 days
    await storage.claimUsername({
      username,
      publicKey,
      expiresAt,
    });

    usernameRecord = await storage.getUsername(username);
    if (!usernameRecord) {
      return { valid: false, error: 'Failed to claim username' };
    }
  }

  // Verify Ed25519 signature
  const isValid = await verifyEd25519Signature(
    usernameRecord.publicKey,
    signature,
    message
  );
  if (!isValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  // Validate message format and timestamp
  const validation = validateAuthMessage(username, message);
  if (!validation.valid) {
    return { valid: false, error: validation.error };
  }

  return { valid: true };
}

/**
 * Extract username from message
 */
function extractUsername(message: string): string | null {
  // Message format: method:username:...
  const parts = message.split(':');
  if (parts.length < 2) return null;
  return parts[1];
}

/**
 * RPC Method Handlers
 */

const handlers: Record<string, RpcHandler> = {
  /**
   * Check if username is available
   */
  async getUser(params, message, signature, publicKey, storage, config) {
    const { username } = params;
    const claimed = await storage.getUsername(username);

    if (!claimed) {
      return {
        username,
        available: true,
      };
    }

    return {
      username: claimed.username,
      available: false,
      claimedAt: claimed.claimedAt,
      expiresAt: claimed.expiresAt,
      publicKey: claimed.publicKey,
    };
  },

  /**
   * Claim a username
   */
  async claimUsername(params, message, signature, publicKey, storage, config) {
    const { username, publicKey: paramPublicKey } = params;

    // Validate claim
    const validation = await validateUsernameClaim(
      username,
      paramPublicKey,
      signature,
      message
    );

    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid username claim');
    }

    // Claim the username
    const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000; // 365 days
    await storage.claimUsername({
      username,
      publicKey: paramPublicKey,
      expiresAt,
    });

    return { success: true, username };
  },

  /**
   * Get service by FQN
   */
  async getService(params, message, signature, publicKey, storage, config) {
    const { serviceFqn, limit, offset } = params;
    const username = extractUsername(message);

    // Verify authentication
    if (username) {
      const auth = await verifyAuth(username, message, signature, publicKey, storage);
      if (!auth.valid) {
        throw new Error(auth.error);
      }
    }

    // Parse and validate FQN
    const fqnValidation = validateServiceFqn(serviceFqn);
    if (!fqnValidation.valid) {
      throw new Error(fqnValidation.error || 'Invalid service FQN');
    }

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed) {
      throw new Error('Failed to parse service FQN');
    }

    // Paginated discovery mode
    if (limit !== undefined) {
      const pageLimit = Math.min(Math.max(1, limit), 100);
      const pageOffset = Math.max(0, offset || 0);

      const allServices = await storage.getServicesByName(
        parsed.service,
        parsed.version
      );
      const compatibleServices = allServices.filter((s) => {
        const serviceVersion = parseServiceFqn(s.serviceFqn);
        return (
          serviceVersion &&
          isVersionCompatible(parsed.version, serviceVersion.version)
        );
      });

      const usernameSet = new Set<string>();
      const uniqueServices: any[] = [];

      for (const service of compatibleServices) {
        if (!usernameSet.has(service.username)) {
          usernameSet.add(service.username);
          const offers = await storage.getOffersForService(service.id);
          const availableOffer = offers.find((o) => !o.answererUsername);

          if (availableOffer) {
            uniqueServices.push({
              serviceId: service.id,
              username: service.username,
              serviceFqn: service.serviceFqn,
              offerId: availableOffer.id,
              sdp: availableOffer.sdp,
              createdAt: service.createdAt,
              expiresAt: service.expiresAt,
            });
          }
        }
      }

      const paginatedServices = uniqueServices.slice(
        pageOffset,
        pageOffset + pageLimit
      );

      return {
        services: paginatedServices,
        count: paginatedServices.length,
        limit: pageLimit,
        offset: pageOffset,
      };
    }

    // Direct lookup with username
    if (parsed.username) {
      const service = await storage.getServiceByFqn(serviceFqn);
      if (!service) {
        throw new Error('Service not found');
      }

      const offers = await storage.getOffersForService(service.id);
      const availableOffer = offers.find((o) => !o.answererUsername);

      if (!availableOffer) {
        throw new Error('Service has no available offers');
      }

      return {
        serviceId: service.id,
        username: service.username,
        serviceFqn: service.serviceFqn,
        offerId: availableOffer.id,
        sdp: availableOffer.sdp,
        createdAt: service.createdAt,
        expiresAt: service.expiresAt,
      };
    }

    // Random discovery without username
    const allServices = await storage.getServicesByName(
      parsed.service,
      parsed.version
    );
    const compatibleServices = allServices.filter((s) => {
      const serviceVersion = parseServiceFqn(s.serviceFqn);
      return (
        serviceVersion &&
        isVersionCompatible(parsed.version, serviceVersion.version)
      );
    });

    if (compatibleServices.length === 0) {
      throw new Error('No services found');
    }

    const randomService =
      compatibleServices[
        Math.floor(Math.random() * compatibleServices.length)
      ];
    const offers = await storage.getOffersForService(randomService.id);
    const availableOffer = offers.find((o) => !o.answererUsername);

    if (!availableOffer) {
      throw new Error('Service has no available offers');
    }

    return {
      serviceId: randomService.id,
      username: randomService.username,
      serviceFqn: randomService.serviceFqn,
      offerId: availableOffer.id,
      sdp: availableOffer.sdp,
      createdAt: randomService.createdAt,
      expiresAt: randomService.expiresAt,
    };
  },

  /**
   * Publish a service
   */
  async publishService(params, message, signature, publicKey, storage, config) {
    const { serviceFqn, offers, ttl } = params;
    const username = extractUsername(message);

    if (!username) {
      throw new Error('Username required for service publishing');
    }

    // Verify authentication
    const auth = await verifyAuth(username, message, signature, publicKey, storage);
    if (!auth.valid) {
      throw new Error(auth.error);
    }

    // Validate service FQN
    const fqnValidation = validateServiceFqn(serviceFqn);
    if (!fqnValidation.valid) {
      throw new Error(fqnValidation.error || 'Invalid service FQN');
    }

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed || !parsed.username) {
      throw new Error('Service FQN must include username');
    }

    if (parsed.username !== username) {
      throw new Error('Service FQN username must match authenticated username');
    }

    // Validate offers
    if (!offers || !Array.isArray(offers) || offers.length === 0) {
      throw new Error('Must provide at least one offer');
    }

    if (offers.length > config.maxOffersPerRequest) {
      throw new Error(
        `Too many offers (max ${config.maxOffersPerRequest})`
      );
    }

    // Create service with offers
    const now = Date.now();
    const offerTtl =
      ttl !== undefined
        ? Math.min(
            Math.max(ttl, config.offerMinTtl),
            config.offerMaxTtl
          )
        : config.offerDefaultTtl;
    const expiresAt = now + offerTtl;

    // Prepare offer requests with TTL
    const offerRequests = offers.map(offer => ({
      username,
      serviceFqn,
      sdp: offer.sdp,
      expiresAt,
    }));

    const result = await storage.createService({
      serviceFqn,
      expiresAt,
      offers: offerRequests,
    });

    return {
      serviceId: result.service.id,
      username: result.service.username,
      serviceFqn: result.service.serviceFqn,
      offers: result.offers.map(offer => ({
        offerId: offer.id,
        sdp: offer.sdp,
        createdAt: offer.createdAt,
        expiresAt: offer.expiresAt,
      })),
      createdAt: result.service.createdAt,
      expiresAt: result.service.expiresAt,
    };
  },

  /**
   * Delete a service
   */
  async deleteService(params, message, signature, publicKey, storage, config) {
    const { serviceFqn } = params;
    const username = extractUsername(message);

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(username, message, signature, publicKey, storage);
    if (!auth.valid) {
      throw new Error(auth.error);
    }

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed || !parsed.username) {
      throw new Error('Service FQN must include username');
    }

    const service = await storage.getServiceByFqn(serviceFqn);
    if (!service) {
      throw new Error('Service not found');
    }

    const deleted = await storage.deleteService(service.id, username);
    if (!deleted) {
      throw new Error('Service not found or not owned by this username');
    }

    return { success: true };
  },

  /**
   * Answer an offer
   */
  async answerOffer(params, message, signature, publicKey, storage, config) {
    const { serviceFqn, offerId, sdp } = params;
    const username = extractUsername(message);

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(username, message, signature, publicKey, storage);
    if (!auth.valid) {
      throw new Error(auth.error);
    }

    if (!sdp || typeof sdp !== 'string' || sdp.length === 0) {
      throw new Error('Invalid SDP');
    }

    if (sdp.length > 64 * 1024) {
      throw new Error('SDP too large (max 64KB)');
    }

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new Error('Offer not found');
    }

    if (offer.answererUsername) {
      throw new Error('Offer already answered');
    }

    await storage.answerOffer(offerId, username, sdp);

    return { success: true, offerId };
  },

  /**
   * Get answer for an offer
   */
  async getOfferAnswer(params, message, signature, publicKey, storage, config) {
    const { serviceFqn, offerId } = params;
    const username = extractUsername(message);

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(username, message, signature, publicKey, storage);
    if (!auth.valid) {
      throw new Error(auth.error);
    }

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new Error('Offer not found');
    }

    if (offer.username !== username) {
      throw new Error('Not authorized to access this offer');
    }

    if (!offer.answererUsername || !offer.answerSdp) {
      throw new Error('Offer not yet answered');
    }

    return {
      sdp: offer.answerSdp,
      offerId: offer.id,
      answererId: offer.answererUsername,
      answeredAt: offer.answeredAt,
    };
  },

  /**
   * Combined polling for answers and ICE candidates
   */
  async poll(params, message, signature, publicKey, storage, config) {
    const { since } = params;
    const username = extractUsername(message);

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(username, message, signature, publicKey, storage);
    if (!auth.valid) {
      throw new Error(auth.error);
    }

    const sinceTimestamp = since || 0;

    // Get all answered offers
    const answeredOffers = await storage.getAnsweredOffers(username);
    const filteredAnswers = answeredOffers.filter(
      (offer) => offer.answeredAt && offer.answeredAt > sinceTimestamp
    );

    // Get all user's offers
    const allOffers = await storage.getOffersByUsername(username);

    // For each offer, get ICE candidates from both sides
    const iceCandidatesByOffer: Record<string, any[]> = {};

    for (const offer of allOffers) {
      const offererCandidates = await storage.getIceCandidates(
        offer.id,
        'offerer',
        sinceTimestamp
      );
      const answererCandidates = await storage.getIceCandidates(
        offer.id,
        'answerer',
        sinceTimestamp
      );

      const allCandidates = [
        ...offererCandidates.map((c: any) => ({
          ...c,
          role: 'offerer' as const,
        })),
        ...answererCandidates.map((c: any) => ({
          ...c,
          role: 'answerer' as const,
        })),
      ];

      if (allCandidates.length > 0) {
        const isOfferer = offer.username === username;
        const filtered = allCandidates.filter((c) =>
          isOfferer ? c.role === 'answerer' : c.role === 'offerer'
        );

        if (filtered.length > 0) {
          iceCandidatesByOffer[offer.id] = filtered;
        }
      }
    }

    return {
      answers: filteredAnswers.map((offer) => ({
        offerId: offer.id,
        serviceId: offer.serviceId,
        answererId: offer.answererUsername,
        sdp: offer.answerSdp,
        answeredAt: offer.answeredAt,
      })),
      iceCandidates: iceCandidatesByOffer,
    };
  },

  /**
   * Add ICE candidates
   */
  async addIceCandidates(params, message, signature, publicKey, storage, config) {
    const { serviceFqn, offerId, candidates } = params;
    const username = extractUsername(message);

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(username, message, signature, publicKey, storage);
    if (!auth.valid) {
      throw new Error(auth.error);
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('Missing or invalid required parameter: candidates');
    }

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new Error('Offer not found');
    }

    const role = offer.username === username ? 'offerer' : 'answerer';
    const count = await storage.addIceCandidates(
      offerId,
      username,
      role,
      candidates
    );

    return { count, offerId };
  },

  /**
   * Get ICE candidates
   */
  async getIceCandidates(params, message, signature, publicKey, storage, config) {
    const { serviceFqn, offerId, since } = params;
    const username = extractUsername(message);

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(username, message, signature, publicKey, storage);
    if (!auth.valid) {
      throw new Error(auth.error);
    }

    const sinceTimestamp = since || 0;

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new Error('Offer not found');
    }

    const isOfferer = offer.username === username;
    const role = isOfferer ? 'answerer' : 'offerer';

    const candidates = await storage.getIceCandidates(
      offerId,
      role,
      sinceTimestamp
    );

    return {
      candidates: candidates.map((c: any) => ({
        candidate: c.candidate,
        createdAt: c.createdAt,
      })),
      offerId,
    };
  },
};

/**
 * Handle RPC batch request
 */
export async function handleRpc(
  requests: RpcRequest[],
  storage: Storage,
  config: Config
): Promise<RpcResponse[]> {
  const responses: RpcResponse[] = [];

  for (const request of requests) {
    try {
      const { method, message, signature, publicKey, params } = request;

      // Validate request
      if (!method || typeof method !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid method',
        });
        continue;
      }

      if (!message || typeof message !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid message',
        });
        continue;
      }

      if (!signature || typeof signature !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid signature',
        });
        continue;
      }

      // Get handler
      const handler = handlers[method];
      if (!handler) {
        responses.push({
          success: false,
          error: `Unknown method: ${method}`,
        });
        continue;
      }

      // Execute handler
      const result = await handler(
        params || {},
        message,
        signature,
        publicKey,
        storage,
        config
      );

      responses.push({
        success: true,
        result,
      });
    } catch (err) {
      responses.push({
        success: false,
        error: (err as Error).message || 'Internal server error',
      });
    }
  }

  return responses;
}
