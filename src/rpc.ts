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

// Constants
const MAX_PAGE_SIZE = 100;

/**
 * RPC request format (body only - auth in headers)
 */
export interface RpcRequest {
  method: string;
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
  username: string,
  timestamp: number,
  signature: string,
  publicKey: string | undefined,
  storage: Storage,
  config: Config,
  request: RpcRequest
) => Promise<any>;

/**
 * Create canonical JSON string with sorted keys for deterministic signing
 */
function canonicalJSON(obj: any): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }
  if (typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalJSON(item)).join(',') + ']';
  }

  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(key => {
    return JSON.stringify(key) + ':' + canonicalJSON(obj[key]);
  });
  return '{' + pairs.join(',') + '}';
}

/**
 * Verify authentication for a method call
 * Automatically claims username if it doesn't exist
 */
async function verifyAuth(
  request: RpcRequest,
  username: string,
  timestamp: number,
  signature: string,
  publicKey: string | undefined,
  storage: Storage
): Promise<{ valid: boolean; error?: string }> {
  // Validate timestamp (not too old, not in future)
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  const maxFuture = 60 * 1000; // 1 minute

  if (timestamp < now - maxAge) {
    return { valid: false, error: 'Timestamp too old' };
  }

  if (timestamp > now + maxFuture) {
    return { valid: false, error: 'Timestamp in future' };
  }

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

    // Create canonical payload for verification
    const payload = { ...request, timestamp, username };
    const canonical = canonicalJSON(payload);

    // Verify signature against the canonical payload
    const signatureValid = await verifyEd25519Signature(publicKey, signature, canonical);
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

  // Create canonical payload for verification: { method, params, timestamp, username }
  const payload = { ...request, timestamp, username };
  const canonical = canonicalJSON(payload);

  // Verify Ed25519 signature
  const isValid = await verifyEd25519Signature(
    usernameRecord.publicKey,
    signature,
    canonical
  );
  if (!isValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

/**
 * RPC Method Handlers
 */

const handlers: Record<string, RpcHandler> = {
  /**
   * Check if username is available
   */
  async getUser(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { username: queriedUsername } = params;
    const claimed = await storage.getUsername(queriedUsername);

    if (!claimed) {
      return {
        username: queriedUsername,
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
   * Get service by FQN - Supports 3 modes:
   * 1. Direct lookup: FQN includes @username
   * 2. Paginated discovery: FQN without @username, with limit/offset
   * 3. Random discovery: FQN without @username, no limit
   */
  async getService(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, limit, offset } = params;

    // Note: getService can be called without auth for discovery
    // Auth is verified if username is provided

    // Parse and validate FQN
    const fqnValidation = validateServiceFqn(serviceFqn);
    if (!fqnValidation.valid) {
      throw new Error(fqnValidation.error || 'Invalid service FQN');
    }

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed) {
      throw new Error('Failed to parse service FQN');
    }

    // Helper: Filter services by version compatibility
    const filterCompatibleServices = (services: any[]) => {
      return services.filter((s: any) => {
        const serviceVersion = parseServiceFqn(s.serviceFqn);
        return (
          serviceVersion &&
          isVersionCompatible(parsed.version, serviceVersion.version)
        );
      });
    };

    // Helper: Find available offer for service
    const findAvailableOffer = async (service: any) => {
      const offers = await storage.getOffersForService(service.id);
      return offers.find((o: any) => !o.answererUsername);
    };

    // Helper: Build service response object
    const buildServiceResponse = (service: any, offer: any) => ({
      serviceId: service.id,
      username: service.username,
      serviceFqn: service.serviceFqn,
      offerId: offer.id,
      sdp: offer.sdp,
      createdAt: service.createdAt,
      expiresAt: service.expiresAt,
    });

    // Mode 1: Paginated discovery
    if (limit !== undefined) {
      const pageLimit = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
      const pageOffset = Math.max(0, offset || 0);

      const allServices = await storage.discoverServices(parsed.serviceName, parsed.version, 1000, 0);
      const compatibleServices = filterCompatibleServices(allServices);

      // Get unique services per username with available offers
      const usernameSet = new Set<string>();
      const uniqueServices: any[] = [];

      for (const service of compatibleServices) {
        if (!usernameSet.has(service.username)) {
          usernameSet.add(service.username);
          const availableOffer = await findAvailableOffer(service);

          if (availableOffer) {
            uniqueServices.push(buildServiceResponse(service, availableOffer));
          }
        }
      }

      // Paginate results
      const paginatedServices = uniqueServices.slice(pageOffset, pageOffset + pageLimit);

      return {
        services: paginatedServices,
        count: paginatedServices.length,
        limit: pageLimit,
        offset: pageOffset,
      };
    }

    // Mode 2: Direct lookup with username
    if (parsed.username) {
      const service = await storage.getServiceByFqn(serviceFqn);
      if (!service) {
        throw new Error('Service not found');
      }

      const availableOffer = await findAvailableOffer(service);
      if (!availableOffer) {
        throw new Error('Service has no available offers');
      }

      return buildServiceResponse(service, availableOffer);
    }

    // Mode 3: Random discovery without username
    const randomService = await storage.getRandomService(parsed.serviceName, parsed.version);

    if (!randomService) {
      throw new Error('No services found');
    }

    const availableOffer = await findAvailableOffer(randomService);

    if (!availableOffer) {
      throw new Error('Service has no available offers');
    }

    return buildServiceResponse(randomService, availableOffer);
  },

  /**
   * Publish a service
   */
  async publishService(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offers, ttl } = params;

    if (!username) {
      throw new Error('Username required for service publishing');
    }

    // Verify authentication
    const auth = await verifyAuth(request, username, timestamp, signature, publicKey, storage);
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

    // Validate each offer has valid SDP
    offers.forEach((offer, index) => {
      if (!offer || typeof offer !== 'object') {
        throw new Error(`Invalid offer at index ${index}: must be an object`);
      }
      if (!offer.sdp || typeof offer.sdp !== 'string') {
        throw new Error(`Invalid offer at index ${index}: missing or invalid SDP`);
      }
      if (!offer.sdp.trim()) {
        throw new Error(`Invalid offer at index ${index}: SDP cannot be empty`);
      }
    });

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
  async deleteService(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn } = params;

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(request, username, timestamp, signature, publicKey, storage);
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
  async answerOffer(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, sdp } = params;

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(request, username, timestamp, signature, publicKey, storage);
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
  async getOfferAnswer(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId } = params;

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(request, username, timestamp, signature, publicKey, storage);
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
  async poll(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { since } = params;

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(request, username, timestamp, signature, publicKey, storage);
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
  async addIceCandidates(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, candidates } = params;

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(request, username, timestamp, signature, publicKey, storage);
    if (!auth.valid) {
      throw new Error(auth.error);
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('Missing or invalid required parameter: candidates');
    }

    // Validate each candidate is an object (don't enforce structure per CLAUDE.md)
    candidates.forEach((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') {
        throw new Error(`Invalid candidate at index ${index}: must be an object`);
      }
    });

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
  async getIceCandidates(params, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, since } = params;

    if (!username) {
      throw new Error('Username required');
    }

    // Verify authentication
    const auth = await verifyAuth(request, username, timestamp, signature, publicKey, storage);
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
 * Handle RPC batch request with header-based authentication
 */
export async function handleRpc(
  requests: RpcRequest[],
  ctx: Context,
  storage: Storage,
  config: Config
): Promise<RpcResponse[]> {
  const responses: RpcResponse[] = [];

  // Read auth headers (same for all requests in batch)
  const signature = ctx.req.header('X-Signature');
  const timestamp = ctx.req.header('X-Timestamp');
  const username = ctx.req.header('X-Username');
  const publicKey = ctx.req.header('X-Public-Key');

  for (const request of requests) {
    try {
      const { method, params } = request;

      // Validate request
      if (!method || typeof method !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid method',
        });
        continue;
      }

      // Validate auth headers
      if (!signature || typeof signature !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid X-Signature header',
        });
        continue;
      }

      if (!timestamp || typeof timestamp !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid X-Timestamp header',
        });
        continue;
      }

      if (!username || typeof username !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid X-Username header',
        });
        continue;
      }

      const timestampNum = parseInt(timestamp, 10);
      if (isNaN(timestampNum)) {
        responses.push({
          success: false,
          error: 'Invalid X-Timestamp header: must be a number',
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
        username,
        timestampNum,
        signature,
        publicKey,
        storage,
        config,
        request
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
