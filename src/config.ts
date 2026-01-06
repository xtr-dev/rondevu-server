import { Storage } from './storage/types.ts';
import { StorageType } from './storage/factory.ts';

// Version is injected at build time via esbuild define
declare const RONDEVU_VERSION: string;
const BUILD_VERSION = typeof RONDEVU_VERSION !== 'undefined' ? RONDEVU_VERSION : 'unknown';

/**
 * Application configuration
 * Reads from environment variables with sensible defaults
 */
export interface Config {
  port: number;
  storageType: StorageType;
  storagePath: string;
  databaseUrl: string;
  dbPoolSize: number;
  corsOrigins: string[];
  version: string;
  offerDefaultTtl: number;
  offerMaxTtl: number;
  offerMinTtl: number;
  answeredOfferTtl: number; // TTL after offer is answered (for ICE exchange)
  cleanupInterval: number;
  maxOffersPerRequest: number;
  maxBatchSize: number;
  maxSdpSize: number;
  maxCandidateSize: number;
  maxCandidateDepth: number;
  maxCandidatesPerRequest: number;
  maxTotalOperations: number;
  timestampMaxAge: number; // Max age for timestamps (replay protection)
  timestampMaxFuture: number; // Max future tolerance for timestamps (clock skew)
  // Resource limits (for abuse prevention)
  maxOffersPerUser: number; // Max concurrent offers per user
  maxTotalOffers: number; // Max total offers in storage
  maxIceCandidatesPerOffer: number; // Max ICE candidates per offer
  requestsPerIpPerSecond: number; // Rate limit: requests per IP per second
}

/**
 * Loads configuration from environment variables
 */
export function loadConfig(): Config {
  // Helper to safely parse and validate integer config values
  function parsePositiveInt(value: string | undefined, defaultValue: string, name: string, min = 1): number {
    const parsed = parseInt(value || defaultValue, 10);
    if (isNaN(parsed)) {
      throw new Error(`${name} must be a valid integer (got: ${value})`);
    }
    if (parsed < min) {
      throw new Error(`${name} must be >= ${min} (got: ${parsed})`);
    }
    return parsed;
  }

  const config = {
    port: parsePositiveInt(process.env.PORT, '3000', 'PORT', 1),
    storageType: (process.env.STORAGE_TYPE || 'memory') as StorageType,
    storagePath: process.env.STORAGE_PATH || ':memory:',
    databaseUrl: process.env.DATABASE_URL || '',
    dbPoolSize: parsePositiveInt(process.env.DB_POOL_SIZE, '10', 'DB_POOL_SIZE', 1),
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
      : ['*'],
    version: process.env.VERSION || BUILD_VERSION,
    offerDefaultTtl: parsePositiveInt(process.env.OFFER_DEFAULT_TTL, '60000', 'OFFER_DEFAULT_TTL', 1000),
    offerMaxTtl: parsePositiveInt(process.env.OFFER_MAX_TTL, '86400000', 'OFFER_MAX_TTL', 1000),
    offerMinTtl: parsePositiveInt(process.env.OFFER_MIN_TTL, '60000', 'OFFER_MIN_TTL', 1000),
    answeredOfferTtl: parsePositiveInt(process.env.ANSWERED_OFFER_TTL, '30000', 'ANSWERED_OFFER_TTL', 1000),
    cleanupInterval: parsePositiveInt(process.env.CLEANUP_INTERVAL, '60000', 'CLEANUP_INTERVAL', 1000),
    maxOffersPerRequest: parsePositiveInt(process.env.MAX_OFFERS_PER_REQUEST, '100', 'MAX_OFFERS_PER_REQUEST', 1),
    maxBatchSize: parsePositiveInt(process.env.MAX_BATCH_SIZE, '100', 'MAX_BATCH_SIZE', 1),
    maxSdpSize: parsePositiveInt(process.env.MAX_SDP_SIZE, String(64 * 1024), 'MAX_SDP_SIZE', 1024), // Min 1KB
    maxCandidateSize: parsePositiveInt(process.env.MAX_CANDIDATE_SIZE, String(4 * 1024), 'MAX_CANDIDATE_SIZE', 256), // Min 256 bytes
    maxCandidateDepth: parsePositiveInt(process.env.MAX_CANDIDATE_DEPTH, '10', 'MAX_CANDIDATE_DEPTH', 1),
    maxCandidatesPerRequest: parsePositiveInt(process.env.MAX_CANDIDATES_PER_REQUEST, '100', 'MAX_CANDIDATES_PER_REQUEST', 1),
    maxTotalOperations: parsePositiveInt(process.env.MAX_TOTAL_OPERATIONS, '1000', 'MAX_TOTAL_OPERATIONS', 1),
    timestampMaxAge: parsePositiveInt(process.env.TIMESTAMP_MAX_AGE, '60000', 'TIMESTAMP_MAX_AGE', 1000), // Min 1 second
    timestampMaxFuture: parsePositiveInt(process.env.TIMESTAMP_MAX_FUTURE, '60000', 'TIMESTAMP_MAX_FUTURE', 1000), // Min 1 second
    // Resource limits
    maxOffersPerUser: parsePositiveInt(process.env.MAX_OFFERS_PER_USER, '1000', 'MAX_OFFERS_PER_USER', 1),
    maxTotalOffers: parsePositiveInt(process.env.MAX_TOTAL_OFFERS, '100000', 'MAX_TOTAL_OFFERS', 1),
    maxIceCandidatesPerOffer: parsePositiveInt(process.env.MAX_ICE_CANDIDATES_PER_OFFER, '50', 'MAX_ICE_CANDIDATES_PER_OFFER', 1),
    requestsPerIpPerSecond: parsePositiveInt(process.env.REQUESTS_PER_IP_PER_SECOND, '50', 'REQUESTS_PER_IP_PER_SECOND', 1),
  };

  return config;
}

/**
 * Default config values (shared between Node and Workers)
 */
export const CONFIG_DEFAULTS = {
  offerDefaultTtl: 60000,
  offerMaxTtl: 86400000,
  offerMinTtl: 60000,
  answeredOfferTtl: 30000, // 30 seconds TTL after offer is answered
  cleanupInterval: 60000,
  maxOffersPerRequest: 100,
  maxBatchSize: 100,
  maxSdpSize: 64 * 1024,
  maxCandidateSize: 4 * 1024,
  maxCandidateDepth: 10,
  maxCandidatesPerRequest: 100,
  maxTotalOperations: 1000,
  timestampMaxAge: 60000,
  timestampMaxFuture: 60000,
  // Resource limits
  maxOffersPerUser: 1000,
  maxTotalOffers: 100000,
  maxIceCandidatesPerOffer: 50,
  requestsPerIpPerSecond: 50,
} as const;

/**
 * Build config for Cloudflare Workers from env vars
 */
export function buildWorkerConfig(env: {
  OFFER_DEFAULT_TTL?: string;
  OFFER_MAX_TTL?: string;
  OFFER_MIN_TTL?: string;
  MAX_OFFERS_PER_REQUEST?: string;
  MAX_BATCH_SIZE?: string;
  CORS_ORIGINS?: string;
  VERSION?: string;
}): Config {
  return {
    port: 0, // Not used in Workers
    storageType: 'sqlite', // D1 is SQLite-compatible
    storagePath: '', // Not used with D1
    databaseUrl: '', // Not used with D1
    dbPoolSize: 10, // Not used with D1
    corsOrigins: env.CORS_ORIGINS?.split(',').map(o => o.trim()) ?? ['*'],
    version: env.VERSION ?? 'unknown',
    offerDefaultTtl: env.OFFER_DEFAULT_TTL ? parseInt(env.OFFER_DEFAULT_TTL, 10) : CONFIG_DEFAULTS.offerDefaultTtl,
    offerMaxTtl: env.OFFER_MAX_TTL ? parseInt(env.OFFER_MAX_TTL, 10) : CONFIG_DEFAULTS.offerMaxTtl,
    offerMinTtl: env.OFFER_MIN_TTL ? parseInt(env.OFFER_MIN_TTL, 10) : CONFIG_DEFAULTS.offerMinTtl,
    answeredOfferTtl: CONFIG_DEFAULTS.answeredOfferTtl,
    cleanupInterval: CONFIG_DEFAULTS.cleanupInterval,
    maxOffersPerRequest: env.MAX_OFFERS_PER_REQUEST ? parseInt(env.MAX_OFFERS_PER_REQUEST, 10) : CONFIG_DEFAULTS.maxOffersPerRequest,
    maxBatchSize: env.MAX_BATCH_SIZE ? parseInt(env.MAX_BATCH_SIZE, 10) : CONFIG_DEFAULTS.maxBatchSize,
    maxSdpSize: CONFIG_DEFAULTS.maxSdpSize,
    maxCandidateSize: CONFIG_DEFAULTS.maxCandidateSize,
    maxCandidateDepth: CONFIG_DEFAULTS.maxCandidateDepth,
    maxCandidatesPerRequest: CONFIG_DEFAULTS.maxCandidatesPerRequest,
    maxTotalOperations: CONFIG_DEFAULTS.maxTotalOperations,
    timestampMaxAge: CONFIG_DEFAULTS.timestampMaxAge,
    timestampMaxFuture: CONFIG_DEFAULTS.timestampMaxFuture,
    // Resource limits
    maxOffersPerUser: CONFIG_DEFAULTS.maxOffersPerUser,
    maxTotalOffers: CONFIG_DEFAULTS.maxTotalOffers,
    maxIceCandidatesPerOffer: CONFIG_DEFAULTS.maxIceCandidatesPerOffer,
    requestsPerIpPerSecond: CONFIG_DEFAULTS.requestsPerIpPerSecond,
  };
}

/**
 * Run cleanup of expired entries (shared between Node and Workers)
 * @returns Object with counts of deleted items
 */
export async function runCleanup(storage: Storage, now: number): Promise<{
  offers: number;
  rateLimits: number;
  nonces: number;
}> {
  const offers = await storage.deleteExpiredOffers(now);
  const rateLimits = await storage.deleteExpiredRateLimits(now);
  const nonces = await storage.deleteExpiredNonces(now);

  return { offers, rateLimits, nonces };
}
