import { Context } from 'hono';
import { Storage, StorageError, StorageErrorCode } from './storage/types.ts';
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
 * Validate Ed25519 public key format (64-character hex string)
 * @param key Public key to validate
 * @returns true if valid format
 */
function validatePublicKeyFormat(key: string): boolean {
  return /^[0-9a-f]{64}$/i.test(key);
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
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  TIMESTAMP_TOO_OLD: 'TIMESTAMP_TOO_OLD',
  TIMESTAMP_IN_FUTURE: 'TIMESTAMP_IN_FUTURE',
  USERNAME_NOT_CLAIMED: 'USERNAME_NOT_CLAIMED',
  INVALID_PUBLIC_KEY: 'INVALID_PUBLIC_KEY',

  // Validation errors
  INVALID_USERNAME: 'INVALID_USERNAME',
  INVALID_FQN: 'INVALID_FQN',
  INVALID_SDP: 'INVALID_SDP',
  INVALID_PARAMS: 'INVALID_PARAMS',
  MISSING_PARAMS: 'MISSING_PARAMS',

  // Resource errors
  OFFER_NOT_FOUND: 'OFFER_NOT_FOUND',
  OFFER_ALREADY_ANSWERED: 'OFFER_ALREADY_ANSWERED',
  OFFER_NOT_ANSWERED: 'OFFER_NOT_ANSWERED',
  NO_AVAILABLE_OFFERS: 'NO_AVAILABLE_OFFERS',
  USERNAME_NOT_AVAILABLE: 'USERNAME_NOT_AVAILABLE',

  // Authorization errors
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  OWNERSHIP_MISMATCH: 'OWNERSHIP_MISMATCH',

  // Limit errors
  TOO_MANY_OFFERS: 'TOO_MANY_OFFERS',
  SDP_TOO_LARGE: 'SDP_TOO_LARGE',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',

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
export interface GetUserParams {
  username: string;
}

export interface ClaimUsernameParams {
  username: string;
  publicKey: string;
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
 * Throws RpcError on authentication failure
 */
async function verifyAuth(
  request: RpcRequest,
  username: string,
  timestamp: number,
  signature: string,
  publicKey: string | undefined,
  storage: Storage,
  config: Config
): Promise<void> {
  // Validate timestamp (not too old, not in future)
  const now = Date.now();

  if (timestamp < now - config.timestampMaxAge) {
    throw new RpcError(ErrorCodes.TIMESTAMP_TOO_OLD, 'Timestamp too old');
  }

  if (timestamp > now + config.timestampMaxFuture) {
    throw new RpcError(ErrorCodes.TIMESTAMP_IN_FUTURE, 'Timestamp in future');
  }

  // Get username record to fetch public key
  let usernameRecord = await storage.getUsername(username);

  // Auto-claim username if it doesn't exist
  //
  // SECURITY ANALYSIS - RACE CONDITION HANDLING:
  //
  // Scenario: Two concurrent requests (A and B) for unclaimed username "alice":
  //   Request A: publicKey = "aaa...", signature = valid for "aaa..."
  //   Request B: publicKey = "bbb...", signature = valid for "bbb..."
  //
  // Race sequence:
  //   1. Both requests call getUsername("alice") → returns null
  //   2. Both requests enter this if block
  //   3. Both requests validate their signatures (both pass)
  //   4. Request A calls claimUsername() → succeeds, claims with "aaa..."
  //   5. Request B calls claimUsername() → FAILS with USERNAME_CONFLICT
  //   6. Request B catches USERNAME_CONFLICT, fetches the claimed record
  //   7. Request B checks if publicKey matches → "bbb..." ≠ "aaa..." → fails correctly
  //
  // Security properties:
  //   ✓ Database enforces uniqueness (UNIQUE constraint on username)
  //   ✓ Losing request correctly fails with USERNAME_NOT_AVAILABLE
  //   ✓ Winning request succeeds normally
  //   ✓ Special case: If same publicKey used twice, second request succeeds (idempotent)
  //   ✓ Signature verification ensures only the actual key owner can succeed
  //   ✓ No authentication bypass possible - signature must match claimed public key
  //
  // This is intentional and secure - no application-level locking needed.
  if (!usernameRecord) {
    if (!publicKey) {
      throw new RpcError(
        ErrorCodes.USERNAME_NOT_CLAIMED,
        `Username "${username}" is not claimed and no public key provided for auto-claim.`
      );
    }

    // Validate public key format
    if (!validatePublicKeyFormat(publicKey)) {
      throw new RpcError(ErrorCodes.INVALID_PUBLIC_KEY, 'Public key must be 64-character hex string');
    }

    // Validate username format before claiming
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_USERNAME, usernameValidation.error || 'Invalid username');
    }

    // Create canonical payload for verification
    const payload = { ...request, timestamp, username };
    const canonical = canonicalJSON(payload);

    // Verify signature against the canonical payload
    const signatureValid = await verifyEd25519Signature(publicKey, signature, canonical);
    if (!signatureValid) {
      throw new RpcError(ErrorCodes.INVALID_SIGNATURE, 'Invalid signature for auto-claim');
    }

    // Auto-claim the username (race condition safe - database enforces uniqueness)
    const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000; // 365 days
    try {
      await storage.claimUsername({
        username,
        publicKey,
        expiresAt,
      });

      usernameRecord = await storage.getUsername(username);
      if (!usernameRecord) {
        throw new RpcError(ErrorCodes.INTERNAL_ERROR, 'Failed to claim username');
      }
    } catch (err: any) {
      // Handle race condition: another request claimed with different public key
      // Using type-safe error detection instead of fragile string matching
      if (err instanceof StorageError && err.code === StorageErrorCode.USERNAME_CONFLICT) {
        // Race condition: Someone else claimed this username with a different key
        // Try to fetch the record to verify it wasn't us (same public key)
        const existingRecord = await storage.getUsername(username);
        if (existingRecord && existingRecord.publicKey === publicKey) {
          // Same public key - we won the race, use the existing record
          usernameRecord = existingRecord;
        } else {
          // Different public key - we lost the race
          throw new RpcError(ErrorCodes.USERNAME_NOT_AVAILABLE, 'Username already claimed by different public key');
        }
      } else if (err instanceof StorageError && err.code === StorageErrorCode.PUBLIC_KEY_CONFLICT) {
        // Handle public key already used for different username
        throw new RpcError(ErrorCodes.USERNAME_NOT_AVAILABLE, 'This public key has already claimed a different username');
      } else if (err instanceof RpcError) {
        // Wrap unexpected errors to prevent leaking internal details
        throw err;
      } else {
        throw new RpcError(ErrorCodes.INTERNAL_ERROR, 'Failed to auto-claim username');
      }
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
    throw new RpcError(ErrorCodes.INVALID_SIGNATURE, 'Invalid signature');
  }
}

/**
 * RPC Method Handlers
 */

const handlers: Record<string, RpcHandler> = {
  /**
   * Check if username is available
   */
  async getUser(params: GetUserParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
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
   * Explicitly claim a username with a public key
   */
  async claimUsername(params: ClaimUsernameParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { username: claimUsername, publicKey: claimPublicKey, expiresAt } = params;

    // Validate that header username matches claim username
    if (username !== claimUsername) {
      throw new RpcError(
        ErrorCodes.AUTH_REQUIRED,
        'X-Username header must match username being claimed'
      );
    }

    // Validate username format
    const usernameValidation = validateUsername(claimUsername);
    if (!usernameValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_USERNAME, usernameValidation.error || 'Invalid username');
    }

    // Validate public key format (must be hex-encoded Ed25519 key - 64 chars)
    if (!validatePublicKeyFormat(claimPublicKey)) {
      throw new RpcError(ErrorCodes.INVALID_PUBLIC_KEY, 'Public key must be 64-character hex string');
    }

    // Check if username is already claimed
    const existing = await storage.getUsername(claimUsername);
    if (existing) {
      throw new RpcError(ErrorCodes.USERNAME_NOT_AVAILABLE, 'Username already claimed');
    }

    // Create canonical payload for verification
    const payload = { ...request, timestamp, username: claimUsername };
    const canonical = canonicalJSON(payload);

    // Verify signature using the provided public key
    const signatureValid = await verifyEd25519Signature(claimPublicKey, signature, canonical);
    if (!signatureValid) {
      throw new RpcError(ErrorCodes.INVALID_SIGNATURE, 'Invalid signature for username claim');
    }

    // Claim the username with provided or default expiration
    const defaultExpiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000; // 365 days
    const finalExpiresAt = expiresAt || defaultExpiresAt;

    await storage.claimUsername({
      username: claimUsername,
      publicKey: claimPublicKey,
      expiresAt: finalExpiresAt,
    });

    return {
      username: claimUsername,
      publicKey: claimPublicKey,
      claimedAt: Date.now(),
      expiresAt: finalExpiresAt,
    };
  },

  /**
   * Get offer by FQN - Supports 3 modes:
   * 1. Direct lookup: FQN includes @username
   * 2. Paginated discovery: FQN without @username, with limit/offset
   * 3. Random discovery: FQN without @username, no limit
   */
  async getOffer(params: GetOfferParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, limit, offset } = params;

    // Note: getOffer can be called without auth for discovery
    // Auth is verified if username is provided

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
        if (username && service.username === username) {
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
    // Note: This could return user's own service in random mode
    // This is acceptable as random discovery is intentionally unpredictable
    const randomService = await storage.getRandomService(parsed.serviceName, parsed.version);

    if (!randomService) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'No offers found');
    }

    const availableOffer = await findAvailableOffer(randomService);

    if (!availableOffer) {
      throw new RpcError(ErrorCodes.NO_AVAILABLE_OFFERS, 'No available offers for this service');
    }

    return buildServiceResponse(randomService, availableOffer);
  },

  /**
   * Publish an offer
   */
  async publishOffer(params: PublishOfferParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offers, ttl } = params;

    if (!username) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Username required for offer publishing');
    }

    // Verify authentication
    await verifyAuth(request, username, timestamp, signature, publicKey, storage, config);

    // Validate service FQN
    const fqnValidation = validateServiceFqn(serviceFqn);
    if (!fqnValidation.valid) {
      throw new RpcError(ErrorCodes.INVALID_FQN, fqnValidation.error || 'Invalid service FQN');
    }

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed || !parsed.username) {
      throw new RpcError(ErrorCodes.INVALID_FQN, 'Service FQN must include username');
    }

    if (parsed.username !== username) {
      throw new RpcError(ErrorCodes.OWNERSHIP_MISMATCH, 'Service FQN username must match authenticated username');
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
   * Delete an offer
   */
  async deleteOffer(params: DeleteOfferParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn } = params;

    if (!username) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Username required');
    }

    // Verify authentication
    await verifyAuth(request, username, timestamp, signature, publicKey, storage, config);

    const parsed = parseServiceFqn(serviceFqn);
    if (!parsed || !parsed.username) {
      throw new RpcError(ErrorCodes.INVALID_FQN, 'Service FQN must include username');
    }

    const service = await storage.getServiceByFqn(serviceFqn);
    if (!service) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    const deleted = await storage.deleteService(service.id, username);
    if (!deleted) {
      throw new RpcError(ErrorCodes.NOT_AUTHORIZED, 'Offer not found or not owned by this username');
    }

    return { success: true };
  },

  /**
   * Answer an offer
   */
  async answerOffer(params: AnswerOfferParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, sdp } = params;

    // Validate input parameters
    validateStringParam(serviceFqn, 'serviceFqn');
    validateStringParam(offerId, 'offerId');

    if (!username) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Username required');
    }

    // Verify authentication
    await verifyAuth(request, username, timestamp, signature, publicKey, storage, config);

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

    await storage.answerOffer(offerId, username, sdp);

    return { success: true, offerId };
  },

  /**
   * Get answer for an offer
   */
  async getOfferAnswer(params: GetOfferAnswerParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId } = params;

    // Validate input parameters
    validateStringParam(serviceFqn, 'serviceFqn');
    validateStringParam(offerId, 'offerId');

    if (!username) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Username required');
    }

    // Verify authentication
    await verifyAuth(request, username, timestamp, signature, publicKey, storage, config);

    const offer = await storage.getOfferById(offerId);
    if (!offer) {
      throw new RpcError(ErrorCodes.OFFER_NOT_FOUND, 'Offer not found');
    }

    if (offer.username !== username) {
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
  async poll(params: PollParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { since } = params;

    if (!username) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Username required');
    }

    // Verify authentication
    await verifyAuth(request, username, timestamp, signature, publicKey, storage, config);

    // Validate since parameter
    if (since !== undefined && (typeof since !== 'number' || since < 0 || !Number.isFinite(since))) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'Invalid since parameter: must be a non-negative number');
    }
    const sinceTimestamp = since !== undefined ? since : 0;

    // Get all answered offers
    const answeredOffers = await storage.getAnsweredOffers(username);
    const filteredAnswers = answeredOffers.filter(
      (offer) => offer.answeredAt && offer.answeredAt > sinceTimestamp
    );

    // Get all user's offers
    const allOffers = await storage.getOffersByUsername(username);

    // For each offer, get ICE candidates from the other peer only
    // Server filters by role - offerers get answerer candidates, answerers get offerer candidates
    const iceCandidatesByOffer: Record<string, any[]> = {};

    for (const offer of allOffers) {
      const isOfferer = offer.username === username;
      const role = isOfferer ? 'answerer' : 'offerer';

      // Get candidates from the other peer (CLAUDE.md: store as raw JSON without modification)
      const candidates = await storage.getIceCandidates(
        offer.id,
        role,
        sinceTimestamp
      );

      if (candidates.length > 0) {
        iceCandidatesByOffer[offer.id] = candidates;
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
  async addIceCandidates(params: AddIceCandidatesParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, candidates } = params;

    // Validate input parameters
    validateStringParam(serviceFqn, 'serviceFqn');
    validateStringParam(offerId, 'offerId');

    if (!username) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Username required');
    }

    // Verify authentication
    await verifyAuth(request, username, timestamp, signature, publicKey, storage, config);

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
  async getIceCandidates(params: GetIceCandidatesParams, username, timestamp, signature, publicKey, storage, config, request: RpcRequest) {
    const { serviceFqn, offerId, since } = params;

    // Validate input parameters
    validateStringParam(serviceFqn, 'serviceFqn');
    validateStringParam(offerId, 'offerId');

    if (!username) {
      throw new RpcError(ErrorCodes.AUTH_REQUIRED, 'Username required');
    }

    // Verify authentication
    await verifyAuth(request, username, timestamp, signature, publicKey, storage, config);

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
    const isOfferer = offer.username === username;
    const isAnswerer = offer.answererUsername === username;

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
const UNAUTHENTICATED_METHODS = new Set(['getUser', 'getOffer']);

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

  // CRITICAL: Pre-calculate total operations BEFORE processing any requests
  // This prevents DoS where first N requests complete before limit triggers
  // Example attack prevented: 100 publishOffer × 100 offers = 10,000 operations
  const MAX_TOTAL_OPERATIONS = 1000;
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
  if (totalOperations > MAX_TOTAL_OPERATIONS) {
    return [{
      success: false,
      error: `Total operations across batch exceed limit: ${totalOperations} > ${MAX_TOTAL_OPERATIONS}`,
      errorCode: ErrorCodes.BATCH_TOO_LARGE,
    }];
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
        if (!signature || typeof signature !== 'string') {
          responses.push({
            success: false,
            error: 'Missing or invalid X-Signature header',
            errorCode: ErrorCodes.AUTH_REQUIRED,
          });
          continue;
        }

        if (!timestamp || typeof timestamp !== 'string') {
          responses.push({
            success: false,
            error: 'Missing or invalid X-Timestamp header',
            errorCode: ErrorCodes.AUTH_REQUIRED,
          });
          continue;
        }

        if (!username || typeof username !== 'string') {
          responses.push({
            success: false,
            error: 'Missing or invalid X-Username header',
            errorCode: ErrorCodes.AUTH_REQUIRED,
          });
          continue;
        }

        const timestampNum = parseInt(timestamp, 10);
        if (isNaN(timestampNum)) {
          responses.push({
            success: false,
            error: 'Invalid X-Timestamp header: must be a number',
            errorCode: ErrorCodes.INVALID_PARAMS,
          });
          continue;
        }

        // Execute handler with auth
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
      } else {
        // Execute handler without strict auth requirement
        // Parse timestamp if provided, otherwise use 0
        const timestampNum = timestamp ? parseInt(timestamp, 10) : 0;

        const result = await handler(
          params || {},
          username || '',
          timestampNum,
          signature || '',
          publicKey,
          storage,
          config,
          request
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
