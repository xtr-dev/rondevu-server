import { Context } from 'hono';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import {
  validateServiceFqn,
  parseServiceFqn,
  isVersionCompatible,
  validateUsername,
  verifySignature,
  buildSignatureMessage,
} from './crypto.ts';

// Constants (non-configurable)
const MAX_PAGE_SIZE = 100;
const MAX_DISCOVERY_RESULTS = 1000;
const DISCOVERY_OFFSET = 0;
// Multiplier for estimated fetch size to account for filtering losses
// Filtering pipeline reduces results through multiple stages:
//   - Version filtering: ~50% pass (keeps compatible versions)
//   - Deduplication: ~70% retained (removes duplicate usernames)
//   - Availability check: ~60% available (has unanswered offers)
// Combined retention: 0.5 × 0.7 × 0.6 = 0.21 (21%)
// Required multiplier: 1/0.21 ≈ 4.76, rounded to 5x for safety margin
const DISCOVERY_FETCH_MULTIPLIER = 5;

// NOTE: MAX_SDP_SIZE, MAX_CANDIDATE_SIZE, MAX_CANDIDATE_DEPTH, and MAX_CANDIDATES_PER_REQUEST
// are now configurable via environment variables (see config.ts)

// ===== Rate Limiting =====

// Rate limiting for credential generation (per IP)
const CREDENTIAL_RATE_LIMIT = 10; // Max credentials per hour per IP
const CREDENTIAL_RATE_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Check JSON object depth to prevent stack overflow from deeply nested objects
 * CRITICAL: Checks depth BEFORE recursing to prevent stack overflow
 * @param obj Object to check
 * @param maxDepth Maximum allowed depth
 * @param currentDepth Current recursion depth
 * @returns Actual depth of the object (returns maxDepth + 1 if exceeded)
 */
function getJsonDepth(obj: any, maxDepth: number, currentDepth = 0): number {
  // Check for primitives/null first
  if (obj === null || typeof obj !== 'object') {
    return currentDepth;
  }

  // CRITICAL: Check depth BEFORE recursing to prevent stack overflow
  // If we're already at max depth, don't recurse further
  if (currentDepth >= maxDepth) {
    return currentDepth + 1; // Indicate exceeded
  }

  let maxChildDepth = currentDepth;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const childDepth = getJsonDepth(obj[key], maxDepth, currentDepth + 1);
      maxChildDepth = Math.max(maxChildDepth, childDepth);

      // Early exit if exceeded
      if (maxChildDepth > maxDepth) {
        return maxChildDepth;
      }
    }
  }

  return maxChildDepth;
}

/**
 * Validate parameter is a non-empty string
 * Prevents type coercion issues and injection attacks
 */
function validateStringParam(value: any, paramName: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${paramName} must be a non-empty string`);
  }
}

/**
 * Standard error codes for RPC responses
 */
export const ErrorCodes = {
  // Authentication errors
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',

  // Validation errors
  INVALID_NAME: 'INVALID_NAME',
  INVALID_FQN: 'INVALID_FQN',
  INVALID_SDP: 'INVALID_SDP',
  INVALID_PARAMS: 'INVALID_PARAMS',
  MISSING_PARAMS: 'MISSING_PARAMS',

  // Resource errors
  OFFER_NOT_FOUND: 'OFFER_NOT_FOUND',
  OFFER_ALREADY_ANSWERED: 'OFFER_ALREADY_ANSWERED',
  OFFER_NOT_ANSWERED: 'OFFER_NOT_ANSWERED',
  NO_AVAILABLE_OFFERS: 'NO_AVAILABLE_OFFERS',

  // Authorization errors
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  OWNERSHIP_MISMATCH: 'OWNERSHIP_MISMATCH',

  // Limit errors
  TOO_MANY_OFFERS: 'TOO_MANY_OFFERS',
  SDP_TOO_LARGE: 'SDP_TOO_LARGE',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // Generic errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
} as const;

/**
 * Custom error class with error code support
 */
export class RpcError extends Error {
  constructor(
    public errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

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
  errorCode?: string;
}

/**
 * RPC Method Parameter Interfaces
 */
export interface GenerateCredentialsParams {
  expiresAt?: number;
}

export interface GetOfferParams {
  serviceFqn: string;
  limit?: number;
  offset?: number;
}

export interface PublishOfferParams {
  serviceFqn: string;
  offers: Array<{ sdp: string }>;
  ttl?: number;
}

export interface DeleteOfferParams {
  serviceFqn: string;
}

export interface AnswerOfferParams {
  serviceFqn: string;
  offerId: string;
  sdp: string;
}

export interface GetOfferAnswerParams {
  serviceFqn: string;
  offerId: string;
}

export interface PollParams {
  since?: number;
}

export interface AddIceCandidatesParams {
  serviceFqn: string;
  offerId: string;
  candidates: any[];
}

export interface GetIceCandidatesParams {
  serviceFqn: string;
  offerId: string;
  since?: number;
}

/**
 * RPC method handler
 * Generic type parameter allows individual handlers to specify their param types
 */
type RpcHandler<TParams = any> = (
  params: TParams,
  name: string,
  timestamp: number,
  signature: string,
  storage: Storage,
  config: Config,
  request: RpcRequest
) => Promise<any>;

/**
 * Validate timestamp for replay attack prevention
 * Throws RpcError if timestamp is invalid
 */
function validateTimestamp(timestamp: number, config: Config): void {
  const now = Date.now();

  // Check if timestamp is too old (replay attack)
  if (now - timestamp > config.timestampMaxAge) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Timestamp too old');
  }

  // Check if timestamp is too far in future (clock skew)
  if (timestamp - now > config.timestampMaxFuture) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Timestamp too far in future');
  }
}

/**
 * Verify request signature for authentication
 * Throws RpcError on authentication failure
 */
async function verifyRequestSignature(
  name: string,
  timestamp: number,
  signature: string,
  method: string,
  params: any,
  storage: Storage,
  config: Config
): Promise<void> {
  // Validate timestamp first
  validateTimestamp(timestamp, config);

  // Get credential to retrieve secret
  const credential = await storage.getCredential(name);
  if (!credential) {
    throw new RpcError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials');
  }

  // Build message and verify signature
  const message = buildSignatureMessage(timestamp, method, params);
  const isValid = await verifySignature(credential.secret, message, signature);

  if (!isValid) {
    throw new RpcError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid signature');
  }

  // Update last used timestamp
  const now = Date.now();
  const expiresAt = now + (365 * 24 * 60 * 60 * 1000); // 1 year
  await storage.updateCredentialUsage(name, now, expiresAt);
}

/**
 * RPC Method Handlers
 */

const handlers: Record<string, RpcHandler> = {
  /**
   * Generate new credentials (name + secret pair)
   * No authentication required - this is how users get started
   * SECURITY: Rate limited per IP to prevent abuse (database-backed for multi-instance support)
   */
  async generateCredentials(params: GenerateCredentialsParams, name, timestamp, signature, storage, config, request: RpcRequest & { clientIp?: string }) {
    // Rate limiting check (IP-based, stored in database)
    const clientIp = request.clientIp || 'unknown';
    const rateLimitKey = `cred_gen:${clientIp}`;

    const allowed = await storage.checkRateLimit(
      rateLimitKey,
      CREDENTIAL_RATE_LIMIT,
      CREDENTIAL_RATE_WINDOW
    );

    if (!allowed) {
      throw new RpcError(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        `Rate limit exceeded. Maximum ${CREDENTIAL_RATE_LIMIT} credentials per hour per IP.`
      );
    }

    const credential = await storage.generateCredentials({
      expiresAt: params.expiresAt,
    });

    return {
      name: credential.name,
      secret: credential.secret,
      createdAt: credential.createdAt,
      expiresAt: credential.expiresAt,
    };
  },

  /**
   * Get offer by FQN - Supports 3 modes:
   * 1. Direct lookup: FQN includes @name (e.g., chat:1.0.0@brave-tiger-7a3f)
   * 2. Paginated discovery: FQN without @name, with limit/offset
   * 3. Random discovery: FQN without @name, no limit
   */
  async getOffer(params: GetOfferParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { serviceFqn, limit, offset } = params;

    // Note: getOffer can be called without auth for discovery
    // Auth is verified if name is provided

    // Parse and validate FQN
    const fqnValidation = validateServiceFqn(serviceFqn);
    if (!fqnValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_FQN, fqnValidation.error || 'Invalid service FQN');
    }

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed) {
      throw new RpcError(ErrorCodes.INVALID_FQN, 'Failed to parse service FQN');
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
      // Validate numeric parameters
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'limit must be a non-negative integer');
      }
      if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'offset must be a non-negative integer');
      }

      const pageLimit = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
      const pageOffset = Math.max(0, offset || 0);

      // Fetch enough services to fill the page after filtering
      // See DISCOVERY_FETCH_MULTIPLIER constant for rationale
      const estimatedFetchSize = Math.min(
        (pageLimit + pageOffset) * DISCOVERY_FETCH_MULTIPLIER,
        MAX_DISCOVERY_RESULTS
      );

      const allServices = await storage.discoverServices(
        parsed.serviceName,
        parsed.version,
        estimatedFetchSize,
        DISCOVERY_OFFSET
      );
      const compatibleServices = filterCompatibleServices(allServices);

      // Get unique services per username with available offers
      // Batch fetch all offers to avoid N+1 query pattern
      const uniqueServices: any[] = [];

      // Collect unique service IDs (one per username)
      const servicesByUsername = new Map<string, any>();
      for (const service of compatibleServices) {
        if (!servicesByUsername.has(service.username)) {
          servicesByUsername.set(service.username, service);
        }
      }

      // Batch fetch offers for all services
      const serviceIds = Array.from(servicesByUsername.values()).map(s => s.id);
      const offersMap = await storage.getOffersForMultipleServices(serviceIds);

      // Build response for services with available offers
      for (const service of servicesByUsername.values()) {
        // Skip user's own services (authenticated users shouldn't discover themselves)
        if (name && service.username === name) {
          continue;
        }

        const offers = offersMap.get(service.id) || [];
        const availableOffer = offers.find((o: any) => !o.answererUsername);

        if (availableOffer) {
          uniqueServices.push(buildServiceResponse(service, availableOffer));
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
        throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
      }

      // Users can explicitly request their own services by username
      // This is intentional - direct lookup allows fetching own offers

      const availableOffer = await findAvailableOffer(service);
      if (!availableOffer) {
        throw new RpcError(ErrorCodes.NO_AVAILABLE_OFFERS, 'No available offers for this service');
      }

      return buildServiceResponse(service, availableOffer);
    }

    // Mode 3: Random discovery without username
    //
    // DESIGN NOTE: Discovery Mode Asymmetry
    // - Paginated mode (limit provided): Filters out user's own services (line 571)
    // - Random mode (no limit): Does NOT filter own services
    // - Direct mode (username in FQN): Allows fetching own services (intentional)
    //
    // Rationale for random mode NOT filtering:
    //   * Random selection happens at database level for performance
    //   * Adding filter would require fetching multiple candidates and re-rolling
    //   * Probability of selecting own service is typically low (1/N services)
    //   * Use case: Self-discovery is valid for testing/monitoring
    //
    // This asymmetry is intentional and acceptable.
    const randomResult = await storage.getRandomService(parsed.serviceName, parsed.version);

    if (!randomResult) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'No offers found');
    }

    return buildServiceResponse(randomResult.service, randomResult.offer);
  },

  /**
   * Publish an offer
   */
  async publishOffer(params: PublishOfferParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { serviceFqn, offers, ttl } = params;

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required for offer publishing');
    }

    // Validate service FQN
    const fqnValidation = validateServiceFqn(serviceFqn);
    if (!fqnValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_FQN, fqnValidation.error || 'Invalid service FQN');
    }

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed || !parsed.username) {
      throw new RpcError(ErrorCodes.INVALID_FQN, 'Service FQN must include username');
    }

    if (parsed.username !== name) {
      throw new RpcError(ErrorCodes.OWNERSHIP_MISMATCH, 'Service FQN username must match authenticated name');
    }

    // Validate offers
    if (!offers || !Array.isArray(offers) || offers.length === 0) {
      throw new RpcError(ErrorCodes.MISSING_PARAMS, 'Must provide at least one offer');
    }

    if (offers.length > config.maxOffersPerRequest) {
      throw new RpcError(
        ErrorCodes.TOO_MANY_OFFERS,
        `Too many offers (max ${config.maxOffersPerRequest})`
      );
    }

    // Validate each offer has valid SDP
    offers.forEach((offer, index) => {
      if (!offer || typeof offer !== 'object') {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `Invalid offer at index ${index}: must be an object`);
      }
      if (!offer.sdp || typeof offer.sdp !== 'string') {
        throw new RpcError(ErrorCodes.INVALID_SDP, `Invalid offer at index ${index}: missing or invalid SDP`);
      }
      if (!offer.sdp.trim()) {
        throw new RpcError(ErrorCodes.INVALID_SDP, `Invalid offer at index ${index}: SDP cannot be empty`);
      }
      if (offer.sdp.length > config.maxSdpSize) {
        throw new RpcError(ErrorCodes.SDP_TOO_LARGE, `SDP too large at index ${index} (max ${config.maxSdpSize} bytes)`);
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
      username: name,
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
   * Delete an offer
   */
  async deleteOffer(params: DeleteOfferParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { serviceFqn } = params;

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required');
    }

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed || !parsed.username) {
      throw new RpcError(ErrorCodes.INVALID_FQN, 'Service FQN must include username');
    }

    const service = await storage.getServiceByFqn(serviceFqn);
    if (!service) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    const deleted = await storage.deleteService(service.id, name);
    if (!deleted) {
      throw new RpcError(ErrorCodes.NOT_AUTHORIZED, 'Offer not found or not owned by this name');
    }

    return { success: true };
  },

  /**
   * Answer an offer
   */
  async answerOffer(params: AnswerOfferParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, sdp } = params;

    // Validate input parameters
    validateStringParam(serviceFqn, 'serviceFqn');
    validateStringParam(offerId, 'offerId');

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required');
    }

    if (!sdp || typeof sdp !== 'string' || sdp.length === 0) {
      throw new RpcError(ErrorCodes.INVALID_SDP, 'Invalid SDP');
    }

    if (sdp.length > config.maxSdpSize) {
      throw new RpcError(ErrorCodes.SDP_TOO_LARGE, `SDP too large (max ${config.maxSdpSize} bytes)`);
    }

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    if (offer.answererUsername) {
      throw new RpcError(ErrorCodes.OFFER_ALREADY_ANSWERED, 'Offer already answered');
    }

    await storage.answerOffer(offerId, name, sdp);

    return { success: true, offerId };
  },

  /**
   * Get answer for an offer
   */
  async getOfferAnswer(params: GetOfferAnswerParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId } = params;

    // Validate input parameters
    validateStringParam(serviceFqn, 'serviceFqn');
    validateStringParam(offerId, 'offerId');

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required');
    }

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    if (offer.username !== name) {
      throw new RpcError(ErrorCodes.NOT_AUTHORIZED, 'Not authorized to access this offer');
    }

    if (!offer.answererUsername || !offer.answerSdp) {
      throw new RpcError(ErrorCodes.OFFER_NOT_ANSWERED, 'Offer not yet answered');
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
  async poll(params: PollParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { since } = params;

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required');
    }

    // Validate since parameter
    if (since !== undefined && (typeof since !== 'number' || since < 0 || !Number.isFinite(since))) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Invalid since parameter: must be a non-negative number');
    }
    const sinceTimestamp = since !== undefined ? since : 0;

    // Get all answered offers
    const answeredOffers = await storage.getAnsweredOffers(name);
    const filteredAnswers = answeredOffers.filter(
      (offer) => offer.answeredAt && offer.answeredAt > sinceTimestamp
    );

    // Get all user's offers
    const allOffers = await storage.getOffersByUsername(name);

    // Batch fetch ICE candidates for all offers using JOIN to avoid N+1 query problem
    // Server filters by role - offerers get answerer candidates, answerers get offerer candidates
    const offerIds = allOffers.map(offer => offer.id);
    const iceCandidatesMap = await storage.getIceCandidatesForMultipleOffers(
      offerIds,
      name,
      sinceTimestamp
    );

    // Convert Map to Record for response
    const iceCandidatesByOffer: Record<string, any[]> = {};
    for (const [offerId, candidates] of iceCandidatesMap.entries()) {
      iceCandidatesByOffer[offerId] = candidates;
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
  async addIceCandidates(params: AddIceCandidatesParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, candidates } = params;

    // Validate input parameters
    validateStringParam(serviceFqn, 'serviceFqn');
    validateStringParam(offerId, 'offerId');

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required');
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new RpcError(ErrorCodes.MISSING_PARAMS, 'Missing or invalid required parameter: candidates');
    }

    if (candidates.length > config.maxCandidatesPerRequest) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `Too many candidates (max ${config.maxCandidatesPerRequest})`
      );
    }

    // Validate each candidate is an object (don't enforce structure per CLAUDE.md)
    candidates.forEach((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `Invalid candidate at index ${index}: must be an object`);
      }

      // Check JSON depth to prevent stack overflow from deeply nested objects
      const depth = getJsonDepth(candidate, config.maxCandidateDepth + 1);
      if (depth > config.maxCandidateDepth) {
        throw new RpcError(
          ErrorCodes.INVALID_PARAMS,
          `Candidate at index ${index} too deeply nested (max depth ${config.maxCandidateDepth})`
        );
      }

      // Ensure candidate is serializable and check size (will be stored as JSON)
      let candidateJson: string;
      try {
        candidateJson = JSON.stringify(candidate);
      } catch (e) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `Candidate at index ${index} is not serializable`);
      }

      // Validate candidate size to prevent abuse
      if (candidateJson.length > config.maxCandidateSize) {
        throw new RpcError(
          ErrorCodes.INVALID_PARAMS,
          `Candidate at index ${index} too large (max ${config.maxCandidateSize} bytes)`
        );
      }
    });

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    // Validate that offer belongs to the specified service
    if (offer.serviceFqn !== serviceFqn) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Offer does not belong to the specified service');
    }

    const role = offer.username === name ? 'offerer' : 'answerer';
    const count = await storage.addIceCandidates(
      offerId,
      name,
      role,
      candidates
    );

    return { count, offerId };
  },

  /**
   * Get ICE candidates
   */
  async getIceCandidates(params: GetIceCandidatesParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, since } = params;

    // Validate input parameters
    validateStringParam(serviceFqn, 'serviceFqn');
    validateStringParam(offerId, 'offerId');

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required');
    }

    // Validate since parameter
    if (since !== undefined && (typeof since !== 'number' || since < 0 || !Number.isFinite(since))) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Invalid since parameter: must be a non-negative number');
    }
    const sinceTimestamp = since !== undefined ? since : 0;

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    // Validate that offer belongs to the specified service
    if (offer.serviceFqn !== serviceFqn) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Offer does not belong to the specified service');
    }

    // Validate that user is authorized to access this offer's candidates
    // Only the offerer and answerer can access ICE candidates
    const isOfferer = offer.username === name;
    const isAnswerer = offer.answererUsername === name;

    if (!isOfferer && !isAnswerer) {
      throw new RpcError(ErrorCodes.NOT_AUTHORIZED, 'Not authorized to access ICE candidates for this offer');
    }

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

// Methods that don't require authentication
const UNAUTHENTICATED_METHODS = new Set(['generateCredentials', 'getOffer']);

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

  // Extract client IP for rate limiting
  // Try multiple headers for proxy compatibility
  const clientIp =
    ctx.req.header('cf-connecting-ip') || // Cloudflare
    ctx.req.header('x-real-ip') || // Nginx
    ctx.req.header('x-forwarded-for')?.split(',')[0].trim() || // Standard proxy
    'unknown';

  // Read auth headers (same for all requests in batch)
  const name = ctx.req.header('X-Name');
  const timestampHeader = ctx.req.header('X-Timestamp');
  const signature = ctx.req.header('X-Signature');

  // Parse timestamp if present
  const timestamp = timestampHeader ? parseInt(timestampHeader, 10) : 0;

  // CRITICAL: Pre-calculate total operations BEFORE processing any requests
  // This prevents DoS where first N requests complete before limit triggers
  // Example attack prevented: 100 publishOffer × 100 offers = 10,000 operations
  let totalOperations = 0;

  // Count all operations across all requests first
  for (const request of requests) {
    const { method, params } = request;
    if (method === 'publishOffer' && params?.offers && Array.isArray(params.offers)) {
      totalOperations += params.offers.length;
    } else if (method === 'addIceCandidates' && params?.candidates && Array.isArray(params.candidates)) {
      totalOperations += params.candidates.length;
    } else {
      totalOperations += 1; // Single operation
    }
  }

  // Reject entire batch if total operations exceed limit
  // This happens BEFORE processing any requests
  // Return error for EACH request to maintain response array alignment
  if (totalOperations > config.maxTotalOperations) {
    return requests.map(() => ({
      success: false,
      error: `Total operations across batch exceed limit: ${totalOperations} > ${config.maxTotalOperations}`,
      errorCode: ErrorCodes.BATCH_TOO_LARGE,
    }));
  }

  // Process all requests
  for (const request of requests) {
    try {
      const { method, params } = request;

      // Validate request
      if (!method || typeof method !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid method',
          errorCode: ErrorCodes.INVALID_PARAMS,
        });
        continue;
      }

      // Get handler
      const handler = handlers[method];
      if (!handler) {
        responses.push({
          success: false,
          error: `Unknown method: ${method}`,
          errorCode: ErrorCodes.UNKNOWN_METHOD,
        });
        continue;
      }

      // Validate auth headers only for methods that require authentication
      const requiresAuth = !UNAUTHENTICATED_METHODS.has(method);

      if (requiresAuth) {
        if (!name || typeof name !== 'string') {
          responses.push({
            success: false,
            error: 'Missing or invalid X-Name header',
            errorCode: ErrorCodes.AUTH_REQUIRED,
          });
          continue;
        }

        if (!timestampHeader || typeof timestampHeader !== 'string' || isNaN(timestamp)) {
          responses.push({
            success: false,
            error: 'Missing or invalid X-Timestamp header',
            errorCode: ErrorCodes.AUTH_REQUIRED,
          });
          continue;
        }

        if (!signature || typeof signature !== 'string') {
          responses.push({
            success: false,
            error: 'Missing or invalid X-Signature header',
            errorCode: ErrorCodes.AUTH_REQUIRED,
          });
          continue;
        }

        // Verify signature (validates timestamp and signature)
        await verifyRequestSignature(
          name,
          timestamp,
          signature,
          method,
          params,
          storage,
          config
        );

        // Execute handler with auth
        const result = await handler(
          params || {},
          name,
          timestamp,
          signature,
          storage,
          config,
          { ...request, clientIp }
        );

        responses.push({
          success: true,
          result,
        });
      } else {
        // Execute handler without strict auth requirement
        const result = await handler(
          params || {},
          name || '',
          0, // timestamp
          '', // signature
          storage,
          config,
          { ...request, clientIp }
        );

        responses.push({
          success: true,
          result,
        });
      }
    } catch (err) {
      if (err instanceof RpcError) {
        responses.push({
          success: false,
          error: err.message,
          errorCode: err.errorCode,
        });
      } else {
        // Generic error - don't leak internal details
        // Log the actual error for debugging
        console.error('Unexpected RPC error:', err);
        responses.push({
          success: false,
          error: 'Internal server error',
          errorCode: ErrorCodes.INTERNAL_ERROR,
        });
      }
    }
  }

  return responses;
}
