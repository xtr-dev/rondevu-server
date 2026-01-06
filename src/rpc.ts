import { Context } from 'hono';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import {
  validateTags,
  validatePublicKey,
  verifyEd25519Signature,
  buildSignatureMessage,
} from './crypto.ts';

// Constants (non-configurable)
const MAX_PAGE_SIZE = 100;
const REQUEST_RATE_WINDOW = 1000; // 1 second in milliseconds

/**
 * Check JSON object depth to prevent stack overflow from deeply nested objects
 */
function getJsonDepth(obj: any, maxDepth: number, currentDepth = 0): number {
  if (obj === null || typeof obj !== 'object') {
    return currentDepth;
  }

  if (currentDepth >= maxDepth) {
    return currentDepth + 1;
  }

  let maxChildDepth = currentDepth;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const childDepth = getJsonDepth(obj[key], maxDepth, currentDepth + 1);
      maxChildDepth = Math.max(maxChildDepth, childDepth);

      if (maxChildDepth > maxDepth) {
        return maxChildDepth;
      }
    }
  }

  return maxChildDepth;
}

/**
 * Validate parameter is a non-empty string
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
  INVALID_PUBLIC_KEY: 'INVALID_PUBLIC_KEY',
  INVALID_TAG: 'INVALID_TAG',
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
  TOO_MANY_OFFERS_PER_USER: 'TOO_MANY_OFFERS_PER_USER',
  STORAGE_FULL: 'STORAGE_FULL',
  TOO_MANY_ICE_CANDIDATES: 'TOO_MANY_ICE_CANDIDATES',

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
  clientIp?: string;
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
export interface DiscoverParams {
  tags: string[];
  limit?: number;
  offset?: number;
}

export interface PublishOfferParams {
  tags: string[];
  offers: Array<{ sdp: string }>;
  ttl?: number;
}

export interface DeleteOfferParams {
  offerId: string;
}

export interface AnswerOfferParams {
  offerId: string;
  sdp: string;
  matchedTags?: string[];
}

export interface GetOfferAnswerParams {
  offerId: string;
}

export interface PollParams {
  since?: number;
}

export interface AddIceCandidatesParams {
  offerId: string;
  candidates: any[];
}

export interface GetIceCandidatesParams {
  offerId: string;
  since?: number;
}

/**
 * RPC method handler
 */
type RpcHandler<TParams = any> = (
  params: TParams,
  publicKey: string,
  timestamp: number,
  signature: string,
  storage: Storage,
  config: Config,
  request: RpcRequest
) => Promise<any>;

/**
 * Validate timestamp for replay attack prevention
 */
function validateTimestamp(timestamp: number, config: Config): void {
  const now = Date.now();

  if (now - timestamp > config.timestampMaxAge) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Timestamp too old');
  }

  if (timestamp - now > config.timestampMaxFuture) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Timestamp too far in future');
  }
}

/**
 * Verify request signature using Ed25519
 * Stateless verification - no identity registration required
 */
async function verifyRequestSignature(
  publicKey: string,
  timestamp: number,
  nonce: string,
  signature: string,
  method: string,
  params: any,
  storage: Storage,
  config: Config
): Promise<void> {
  // Validate timestamp first
  validateTimestamp(timestamp, config);

  // Validate public key format
  const pkValidation = validatePublicKey(publicKey);
  if (!pkValidation.valid) {
    throw new RpcError(ErrorCodes.INVALID_PUBLIC_KEY, pkValidation.error || 'Invalid public key');
  }

  // Build message and verify Ed25519 signature
  const message = buildSignatureMessage(timestamp, nonce, method, params);
  const isValid = await verifyEd25519Signature(publicKey, message, signature);

  if (!isValid) {
    throw new RpcError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid signature');
  }

  // Check nonce uniqueness AFTER successful signature verification
  const nonceKey = `nonce:${publicKey}:${nonce}`;
  const nonceExpiresAt = timestamp + config.timestampMaxAge;
  const nonceIsNew = await storage.checkAndMarkNonce(nonceKey, nonceExpiresAt);

  if (!nonceIsNew) {
    throw new RpcError(ErrorCodes.INVALID_CREDENTIALS, 'Nonce already used (replay attack detected)');
  }
}

/**
 * RPC Method Handlers
 */
const handlers: Record<string, RpcHandler> = {
  /**
   * Discover offers by tags
   */
  async discover(params: DiscoverParams, publicKey, timestamp, signature, storage, config, request: RpcRequest) {
    const { tags, limit, offset } = params;

    const tagsValidation = validateTags(tags);
    if (!tagsValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_TAG, tagsValidation.error || 'Invalid tags');
    }

    // Mode 1: Paginated discovery
    if (limit !== undefined) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'limit must be a non-negative integer');
      }
      if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'offset must be a non-negative integer');
      }

      const pageLimit = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
      const pageOffset = Math.max(0, offset || 0);

      const excludePublicKey = publicKey || null;

      const offers = await storage.discoverOffers(
        tags,
        excludePublicKey,
        pageLimit,
        pageOffset
      );

      return {
        offers: offers.map(offer => ({
          offerId: offer.id,
          publicKey: offer.publicKey,
          tags: offer.tags,
          sdp: offer.sdp,
          createdAt: offer.createdAt,
          expiresAt: offer.expiresAt,
        })),
        count: offers.length,
        limit: pageLimit,
        offset: pageOffset,
      };
    }

    // Mode 2: Random discovery
    const excludePublicKey = publicKey || null;
    const offer = await storage.getRandomOffer(tags, excludePublicKey);

    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'No offers found matching tags');
    }

    return {
      offerId: offer.id,
      publicKey: offer.publicKey,
      tags: offer.tags,
      sdp: offer.sdp,
      createdAt: offer.createdAt,
      expiresAt: offer.expiresAt,
    };
  },

  /**
   * Publish offers with tags
   */
  async publishOffer(params: PublishOfferParams, publicKey, timestamp, signature, storage, config, request: RpcRequest) {
    const { tags, offers, ttl } = params;

    if (!publicKey) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Authentication required for offer publishing');
    }

    const tagsValidation = validateTags(tags);
    if (!tagsValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_TAG, tagsValidation.error || 'Invalid tags');
    }

    if (!offers || !Array.isArray(offers) || offers.length === 0) {
      throw new RpcError(ErrorCodes.MISSING_PARAMS, 'Must provide at least one offer');
    }

    if (offers.length > config.maxOffersPerRequest) {
      throw new RpcError(
        ErrorCodes.TOO_MANY_OFFERS,
        `Too many offers (max ${config.maxOffersPerRequest})`
      );
    }

    const userOfferCount = await storage.getOfferCountByPublicKey(publicKey);
    if (userOfferCount + offers.length > config.maxOffersPerUser) {
      throw new RpcError(
        ErrorCodes.TOO_MANY_OFFERS_PER_USER,
        `User offer limit exceeded. You have ${userOfferCount} offers, limit is ${config.maxOffersPerUser}.`
      );
    }

    const totalOfferCount = await storage.getOfferCount();
    if (totalOfferCount + offers.length > config.maxTotalOffers) {
      throw new RpcError(
        ErrorCodes.STORAGE_FULL,
        `Server offer limit reached (${config.maxTotalOffers}). Try again later.`
      );
    }

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

    if (ttl !== undefined) {
      if (typeof ttl !== 'number' || isNaN(ttl) || ttl < 0) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'TTL must be a non-negative number');
      }
    }

    const now = Date.now();
    const offerTtl =
      ttl !== undefined
        ? Math.min(Math.max(ttl, config.offerMinTtl), config.offerMaxTtl)
        : config.offerDefaultTtl;
    const expiresAt = now + offerTtl;

    const offerRequests = offers.map(offer => ({
      publicKey,
      tags,
      sdp: offer.sdp,
      expiresAt,
    }));

    const createdOffers = await storage.createOffers(offerRequests);

    return {
      publicKey,
      tags,
      offers: createdOffers.map(offer => ({
        offerId: offer.id,
        sdp: offer.sdp,
        createdAt: offer.createdAt,
        expiresAt: offer.expiresAt,
      })),
      createdAt: now,
      expiresAt,
    };
  },

  /**
   * Delete an offer by ID
   */
  async deleteOffer(params: DeleteOfferParams, publicKey, timestamp, signature, storage, config, request: RpcRequest) {
    const { offerId } = params;

    if (!publicKey) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Authentication required');
    }

    validateStringParam(offerId, 'offerId');

    const deleted = await storage.deleteOffer(offerId, publicKey);
    if (!deleted) {
      throw new RpcError(ErrorCodes.NOT_AUTHORIZED, 'Offer not found or not owned by this identity');
    }

    return { success: true };
  },

  /**
   * Answer an offer
   */
  async answerOffer(params: AnswerOfferParams, publicKey, timestamp, signature, storage, config, request: RpcRequest) {
    const { offerId, sdp, matchedTags } = params;

    validateStringParam(offerId, 'offerId');

    if (!publicKey) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Authentication required');
    }

    if (!sdp || typeof sdp !== 'string' || sdp.length === 0) {
      throw new RpcError(ErrorCodes.INVALID_SDP, 'Invalid SDP');
    }

    if (sdp.length > config.maxSdpSize) {
      throw new RpcError(ErrorCodes.SDP_TOO_LARGE, `SDP too large (max ${config.maxSdpSize} bytes)`);
    }

    if (matchedTags !== undefined && !Array.isArray(matchedTags)) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'matchedTags must be an array');
    }

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    if (offer.answererPublicKey) {
      throw new RpcError(ErrorCodes.OFFER_ALREADY_ANSWERED, 'Offer already answered');
    }

    if (matchedTags && matchedTags.length > 0) {
      const offerTagSet = new Set(offer.tags);
      const invalidTags = matchedTags.filter(tag => !offerTagSet.has(tag));
      if (invalidTags.length > 0) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `matchedTags contains tags not on offer: ${invalidTags.join(', ')}`);
      }
    }

    // Reduce TTL after answer for faster cleanup (answered offers no longer appear in discovery)
    const newExpiresAt = Date.now() + config.answeredOfferTtl;
    await storage.answerOffer(offerId, publicKey, sdp, matchedTags, newExpiresAt);

    return { success: true, offerId };
  },

  /**
   * Get answer for an offer
   */
  async getOfferAnswer(params: GetOfferAnswerParams, publicKey, timestamp, signature, storage, config, request: RpcRequest) {
    const { offerId } = params;

    validateStringParam(offerId, 'offerId');

    if (!publicKey) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Authentication required');
    }

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    if (offer.publicKey !== publicKey) {
      throw new RpcError(ErrorCodes.NOT_AUTHORIZED, 'Not authorized to access this offer');
    }

    if (!offer.answererPublicKey || !offer.answerSdp) {
      throw new RpcError(ErrorCodes.OFFER_NOT_ANSWERED, 'Offer not yet answered');
    }

    return {
      sdp: offer.answerSdp,
      offerId: offer.id,
      answererPublicKey: offer.answererPublicKey,
      answeredAt: offer.answeredAt,
    };
  },

  /**
   * Combined polling for answers and ICE candidates
   */
  async poll(params: PollParams, publicKey, timestamp, signature, storage, config, request: RpcRequest) {
    const { since } = params;

    if (!publicKey) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Authentication required');
    }

    if (since !== undefined && (typeof since !== 'number' || since < 0 || !Number.isFinite(since))) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Invalid since parameter: must be a non-negative number');
    }
    const sinceTimestamp = since !== undefined ? since : 0;

    const answeredOffers = await storage.getAnsweredOffers(publicKey);
    const filteredAnswers = answeredOffers.filter(
      (offer) => offer.answeredAt && offer.answeredAt > sinceTimestamp
    );

    const ownedOffers = await storage.getOffersByPublicKey(publicKey);
    const answeredByUser = await storage.getOffersAnsweredBy(publicKey);

    const allOfferIds = [
      ...ownedOffers.map(offer => offer.id),
      ...answeredByUser.map(offer => offer.id),
    ];
    const offerIds = [...new Set(allOfferIds)];

    const iceCandidatesMap = await storage.getIceCandidatesForMultipleOffers(
      offerIds,
      publicKey,
      sinceTimestamp
    );

    const iceCandidatesByOffer: Record<string, any[]> = {};
    for (const [offerId, candidates] of iceCandidatesMap.entries()) {
      iceCandidatesByOffer[offerId] = candidates;
    }

    return {
      answers: filteredAnswers.map((offer) => ({
        offerId: offer.id,
        answererPublicKey: offer.answererPublicKey,
        sdp: offer.answerSdp,
        answeredAt: offer.answeredAt,
        matchedTags: offer.matchedTags,
      })),
      iceCandidates: iceCandidatesByOffer,
    };
  },

  /**
   * Add ICE candidates
   */
  async addIceCandidates(params: AddIceCandidatesParams, publicKey, timestamp, signature, storage, config, request: RpcRequest) {
    const { offerId, candidates } = params;

    validateStringParam(offerId, 'offerId');

    if (!publicKey) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Authentication required');
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

    candidates.forEach((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `Invalid candidate at index ${index}: must be an object`);
      }

      const depth = getJsonDepth(candidate, config.maxCandidateDepth + 1);
      if (depth > config.maxCandidateDepth) {
        throw new RpcError(
          ErrorCodes.INVALID_PARAMS,
          `Candidate at index ${index} too deeply nested (max depth ${config.maxCandidateDepth})`
        );
      }

      let candidateJson: string;
      try {
        candidateJson = JSON.stringify(candidate);
      } catch (e) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `Candidate at index ${index} is not serializable`);
      }

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

    const currentCandidateCount = await storage.getIceCandidateCount(offerId);
    if (currentCandidateCount + candidates.length > config.maxIceCandidatesPerOffer) {
      throw new RpcError(
        ErrorCodes.TOO_MANY_ICE_CANDIDATES,
        `ICE candidate limit exceeded for offer. Current: ${currentCandidateCount}, limit: ${config.maxIceCandidatesPerOffer}.`
      );
    }

    const role = offer.publicKey === publicKey ? 'offerer' : 'answerer';
    const count = await storage.addIceCandidates(
      offerId,
      publicKey,
      role,
      candidates
    );

    return { count, offerId };
  },

  /**
   * Get ICE candidates
   */
  async getIceCandidates(params: GetIceCandidatesParams, publicKey, timestamp, signature, storage, config, request: RpcRequest) {
    const { offerId, since } = params;

    validateStringParam(offerId, 'offerId');

    if (!publicKey) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Authentication required');
    }

    if (since !== undefined && (typeof since !== 'number' || since < 0 || !Number.isFinite(since))) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Invalid since parameter: must be a non-negative number');
    }
    const sinceTimestamp = since !== undefined ? since : 0;

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    const isOfferer = offer.publicKey === publicKey;
    const isAnswerer = offer.answererPublicKey === publicKey;

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
const UNAUTHENTICATED_METHODS = new Set(['discover']);

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

  const clientIp =
    ctx.req.header('cf-connecting-ip') ||
    ctx.req.header('x-real-ip') ||
    ctx.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    undefined;

  // General request rate limiting (per IP per second)
  if (clientIp) {
    const rateLimitKey = `req:${clientIp}`;
    const allowed = await storage.checkRateLimit(
      rateLimitKey,
      config.requestsPerIpPerSecond,
      REQUEST_RATE_WINDOW
    );

    if (!allowed) {
      return requests.map(() => ({
        success: false,
        error: `Rate limit exceeded. Maximum ${config.requestsPerIpPerSecond} requests per second per IP.`,
        errorCode: ErrorCodes.RATE_LIMIT_EXCEEDED,
      }));
    }
  }

  // Read auth headers (X-PublicKey instead of X-Name)
  const publicKey = ctx.req.header('X-PublicKey');
  const timestampHeader = ctx.req.header('X-Timestamp');
  const nonce = ctx.req.header('X-Nonce');
  const signature = ctx.req.header('X-Signature');

  const timestamp = timestampHeader ? parseInt(timestampHeader, 10) : 0;

  // Pre-calculate total operations
  let totalOperations = 0;
  for (const request of requests) {
    const { method, params } = request;
    if (method === 'publishOffer' && params?.offers && Array.isArray(params.offers)) {
      totalOperations += params.offers.length;
    } else if (method === 'addIceCandidates' && params?.candidates && Array.isArray(params.candidates)) {
      totalOperations += params.candidates.length;
    } else {
      totalOperations += 1;
    }
  }

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

      if (!method || typeof method !== 'string') {
        responses.push({
          success: false,
          error: 'Missing or invalid method',
          errorCode: ErrorCodes.INVALID_PARAMS,
        });
        continue;
      }

      const handler = handlers[method];
      if (!handler) {
        responses.push({
          success: false,
          error: `Unknown method: ${method}`,
          errorCode: ErrorCodes.UNKNOWN_METHOD,
        });
        continue;
      }

      const requiresAuth = !UNAUTHENTICATED_METHODS.has(method);

      if (requiresAuth) {
        if (!publicKey || typeof publicKey !== 'string') {
          responses.push({
            success: false,
            error: 'Missing or invalid X-PublicKey header',
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

        if (!nonce || typeof nonce !== 'string') {
          responses.push({
            success: false,
            error: 'Missing or invalid X-Nonce header (use crypto.randomUUID())',
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

        // Verify Ed25519 signature
        await verifyRequestSignature(
          publicKey,
          timestamp,
          nonce,
          signature,
          method,
          params,
          storage,
          config
        );

        const result = await handler(
          params || {},
          publicKey,
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
          publicKey || '',
          0,
          '',
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
