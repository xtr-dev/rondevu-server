import { Context } from 'hono';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import {
  validateTags,
  validateUsername,
  verifySignature,
  buildSignatureMessage,
} from './crypto.ts';

// Constants (non-configurable)
const MAX_PAGE_SIZE = 100;

// NOTE: MAX_SDP_SIZE, MAX_CANDIDATE_SIZE, MAX_CANDIDATE_DEPTH, and MAX_CANDIDATES_PER_REQUEST
// are now configurable via environment variables (see config.ts)

// ===== Rate Limiting =====

// Rate limiting windows (these are fixed, limits come from config)
// NOTE: Uses fixed-window rate limiting with full window reset on expiry
//   - Window starts on first request and expires after window duration
//   - When window expires, counter resets to 0 and new window starts
//   - This is simpler than sliding windows but may allow bursts at window boundaries
const CREDENTIAL_RATE_WINDOW = 1000; // 1 second in milliseconds
const REQUEST_RATE_WINDOW = 1000; // 1 second in milliseconds

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
export interface GenerateCredentialsParams {
  name?: string;       // Optional: claim specific username (4-32 chars, alphanumeric + dashes + periods)
  expiresAt?: number;
}

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
  matchedTags?: string[];  // Tags the answerer searched for to find this offer
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
  nonce: string,
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

  // Build message and verify signature (includes nonce to prevent signature reuse)
  const message = buildSignatureMessage(timestamp, nonce, method, params);
  const isValid = await verifySignature(credential.secret, message, signature);

  if (!isValid) {
    throw new RpcError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid signature');
  }

  // Check nonce uniqueness AFTER successful signature verification
  // This prevents DoS where invalid signatures burn nonces
  // Only valid authenticated requests can mark nonces as used
  const nonceKey = `nonce:${name}:${nonce}`;
  const nonceExpiresAt = timestamp + config.timestampMaxAge;
  const nonceIsNew = await storage.checkAndMarkNonce(nonceKey, nonceExpiresAt);

  if (!nonceIsNew) {
    throw new RpcError(ErrorCodes.INVALID_CREDENTIALS, 'Nonce already used (replay attack detected)');
  }

  // Update last used timestamp
  const now = Date.now();
  const credentialExpiresAt = now + (365 * 24 * 60 * 60 * 1000); // 1 year
  await storage.updateCredentialUsage(name, now, credentialExpiresAt);
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
    // Check total credentials limit
    const credentialCount = await storage.getCredentialCount();
    if (credentialCount >= config.maxTotalCredentials) {
      throw new RpcError(
        ErrorCodes.STORAGE_FULL,
        `Server credential limit reached (${config.maxTotalCredentials}). Try again later.`
      );
    }

    // Rate limiting check (IP-based, stored in database)
    // SECURITY: Use stricter global rate limit for requests without identifiable IP
    let rateLimitKey: string;
    let rateLimit: number;

    if (!request.clientIp) {
      // Warn about missing IP (suggests proxy misconfiguration)
      console.warn('⚠️  WARNING: Unable to determine client IP for credential generation. Using global rate limit.');
      // Use global rate limit with much stricter limit (prevents DoS while allowing basic function)
      rateLimitKey = 'cred_gen:global_unknown';
      rateLimit = 2; // Only 2 credentials per second globally for all unknown IPs combined
    } else {
      rateLimitKey = `cred_gen:${request.clientIp}`;
      rateLimit = config.credentialsPerIpPerSecond;
    }

    const allowed = await storage.checkRateLimit(
      rateLimitKey,
      rateLimit,
      CREDENTIAL_RATE_WINDOW
    );

    if (!allowed) {
      throw new RpcError(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        `Rate limit exceeded. Maximum ${rateLimit} credentials per second${request.clientIp ? ' per IP' : ' (global limit for unidentified IPs)'}.`
      );
    }

    // Validate username if provided
    if (params.name !== undefined) {
      if (typeof params.name !== 'string') {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'name must be a string');
      }
      const usernameValidation = validateUsername(params.name);
      if (!usernameValidation.valid) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, usernameValidation.error || 'Invalid username');
      }
    }

    // Validate expiresAt if provided
    if (params.expiresAt !== undefined) {
      if (typeof params.expiresAt !== 'number' || isNaN(params.expiresAt) || !Number.isFinite(params.expiresAt)) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'expiresAt must be a valid timestamp');
      }
      // Prevent setting expiry in the past (with 1 minute tolerance for clock skew)
      const now = Date.now();
      if (params.expiresAt < now - 60000) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'expiresAt cannot be in the past');
      }
      // Prevent unreasonably far future expiry (max 10 years)
      const maxFuture = now + (10 * 365 * 24 * 60 * 60 * 1000);
      if (params.expiresAt > maxFuture) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'expiresAt cannot be more than 10 years in the future');
      }
    }

    try {
      const credential = await storage.generateCredentials({
        name: params.name,
        expiresAt: params.expiresAt,
      });

      return {
        name: credential.name,
        secret: credential.secret,
        createdAt: credential.createdAt,
        expiresAt: credential.expiresAt,
      };
    } catch (error: any) {
      if (error.message === 'Username already taken') {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Username already taken');
      }
      throw error;
    }
  },

  /**
   * Discover offers by tags - Supports 2 modes:
   * 1. Paginated discovery: tags array with limit/offset
   * 2. Random discovery: tags array without limit (returns single random offer)
   */
  async discover(params: DiscoverParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { tags, limit, offset } = params;

    // Validate tags
    const tagsValidation = validateTags(tags);
    if (!tagsValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_TAG, tagsValidation.error || 'Invalid tags');
    }

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

      // Exclude self if authenticated
      const excludeUsername = name || null;

      const offers = await storage.discoverOffers(
        tags,
        excludeUsername,
        pageLimit,
        pageOffset
      );

      return {
        offers: offers.map(offer => ({
          offerId: offer.id,
          username: offer.username,
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

    // Mode 2: Random discovery (no limit provided)
    // Exclude self if authenticated
    const excludeUsername = name || null;

    const offer = await storage.getRandomOffer(tags, excludeUsername);

    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'No offers found matching tags');
    }

    return {
      offerId: offer.id,
      username: offer.username,
      tags: offer.tags,
      sdp: offer.sdp,
      createdAt: offer.createdAt,
      expiresAt: offer.expiresAt,
    };
  },

  /**
   * Publish offers with tags
   */
  async publishOffer(params: PublishOfferParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { tags, offers, ttl } = params;

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required for offer publishing');
    }

    // Validate tags
    const tagsValidation = validateTags(tags);
    if (!tagsValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_TAG, tagsValidation.error || 'Invalid tags');
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

    // Check per-user offer limit
    const userOfferCount = await storage.getOfferCountByUsername(name);
    if (userOfferCount + offers.length > config.maxOffersPerUser) {
      throw new RpcError(
        ErrorCodes.TOO_MANY_OFFERS_PER_USER,
        `User offer limit exceeded. You have ${userOfferCount} offers, limit is ${config.maxOffersPerUser}.`
      );
    }

    // Check total offers limit
    const totalOfferCount = await storage.getOfferCount();
    if (totalOfferCount + offers.length > config.maxTotalOffers) {
      throw new RpcError(
        ErrorCodes.STORAGE_FULL,
        `Server offer limit reached (${config.maxTotalOffers}). Try again later.`
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

    // Validate TTL if provided
    if (ttl !== undefined) {
      if (typeof ttl !== 'number' || isNaN(ttl) || ttl < 0) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, 'TTL must be a non-negative number');
      }
    }

    // Create offers with tags
    const now = Date.now();
    const offerTtl =
      ttl !== undefined
        ? Math.min(
            Math.max(ttl, config.offerMinTtl),
            config.offerMaxTtl
          )
        : config.offerDefaultTtl;
    const expiresAt = now + offerTtl;

    // Prepare offer requests with tags
    const offerRequests = offers.map(offer => ({
      username: name,
      tags,
      sdp: offer.sdp,
      expiresAt,
    }));

    const createdOffers = await storage.createOffers(offerRequests);

    return {
      username: name,
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
  async deleteOffer(params: DeleteOfferParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { offerId } = params;

    if (!name) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Name required');
    }

    validateStringParam(offerId, 'offerId');

    const deleted = await storage.deleteOffer(offerId, name);
    if (!deleted) {
      throw new RpcError(ErrorCodes.NOT_AUTHORIZED, 'Offer not found or not owned by this name');
    }

    return { success: true };
  },

  /**
   * Answer an offer
   */
  async answerOffer(params: AnswerOfferParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { offerId, sdp, matchedTags } = params;

    // Validate input parameters
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

    // Validate matchedTags if provided
    if (matchedTags !== undefined && !Array.isArray(matchedTags)) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'matchedTags must be an array');
    }

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    if (offer.answererUsername) {
      throw new RpcError(ErrorCodes.OFFER_ALREADY_ANSWERED, 'Offer already answered');
    }

    // Validate that matchedTags are actually tags on the offer
    if (matchedTags && matchedTags.length > 0) {
      const offerTagSet = new Set(offer.tags);
      const invalidTags = matchedTags.filter(tag => !offerTagSet.has(tag));
      if (invalidTags.length > 0) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `matchedTags contains tags not on offer: ${invalidTags.join(', ')}`);
      }
    }

    await storage.answerOffer(offerId, name, sdp, matchedTags);

    return { success: true, offerId };
  },

  /**
   * Get answer for an offer
   */
  async getOfferAnswer(params: GetOfferAnswerParams, name, timestamp, signature, storage, config, request: RpcRequest) {
    const { offerId } = params;

    // Validate input parameters
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

    // Get all answered offers (where user is the offerer)
    const answeredOffers = await storage.getAnsweredOffers(name);
    const filteredAnswers = answeredOffers.filter(
      (offer) => offer.answeredAt && offer.answeredAt > sinceTimestamp
    );

    // Get all user's offers (where user is offerer)
    const ownedOffers = await storage.getOffersByUsername(name);

    // Get all offers the user has answered (where user is answerer)
    const answeredByUser = await storage.getOffersAnsweredBy(name);

    // Combine offer IDs from both sources for ICE candidate fetching
    // The storage method handles filtering by role automatically
    const allOfferIds = [
      ...ownedOffers.map(offer => offer.id),
      ...answeredByUser.map(offer => offer.id),
    ];
    // Remove duplicates (shouldn't happen, but defensive)
    const offerIds = [...new Set(allOfferIds)];

    // Batch fetch ICE candidates for all offers using JOIN to avoid N+1 query problem
    // Server filters by role - offerers get answerer candidates, answerers get offerer candidates
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
    const { offerId, candidates } = params;

    // Validate input parameters
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

    // Check ICE candidates limit per offer
    const currentCandidateCount = await storage.getIceCandidateCount(offerId);
    if (currentCandidateCount + candidates.length > config.maxIceCandidatesPerOffer) {
      throw new RpcError(
        ErrorCodes.TOO_MANY_ICE_CANDIDATES,
        `ICE candidate limit exceeded for offer. Current: ${currentCandidateCount}, limit: ${config.maxIceCandidatesPerOffer}.`
      );
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
    const { offerId, since } = params;

    // Validate input parameters
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
const UNAUTHENTICATED_METHODS = new Set(['generateCredentials', 'discover']);

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
    ctx.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    undefined; // Don't use fallback - let handlers decide how to handle missing IP

  // General request rate limiting (per IP per second)
  if (clientIp) {
    const rateLimitKey = `req:${clientIp}`;
    const allowed = await storage.checkRateLimit(
      rateLimitKey,
      config.requestsPerIpPerSecond,
      REQUEST_RATE_WINDOW
    );

    if (!allowed) {
      // Return error for all requests in the batch
      return requests.map(() => ({
        success: false,
        error: `Rate limit exceeded. Maximum ${config.requestsPerIpPerSecond} requests per second per IP.`,
        errorCode: ErrorCodes.RATE_LIMIT_EXCEEDED,
      }));
    }
  }

  // Read auth headers (same for all requests in batch)
  const name = ctx.req.header('X-Name');
  const timestampHeader = ctx.req.header('X-Timestamp');
  const nonce = ctx.req.header('X-Nonce');
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

        // Verify signature (validates timestamp, nonce, and signature)
        await verifyRequestSignature(
          name,
          timestamp,
          nonce,
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
