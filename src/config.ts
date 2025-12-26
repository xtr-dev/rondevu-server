/**
 * Application configuration
 * Reads from environment variables with sensible defaults
 */
export interface Config {
  port: number;
  storageType: 'sqlite' | 'memory';
  storagePath: string;
  corsOrigins: string[];
  version: string;
  offerDefaultTtl: number;
  offerMaxTtl: number;
  offerMinTtl: number;
  cleanupInterval: number;
  maxOffersPerRequest: number;
  maxBatchSize: number;
}

/**
 * Loads configuration from environment variables
 */
export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    storageType: (process.env.STORAGE_TYPE || 'sqlite') as 'sqlite' | 'memory',
    storagePath: process.env.STORAGE_PATH || ':memory:',
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
      : ['*'],
    version: process.env.VERSION || 'unknown',
    offerDefaultTtl: parseInt(process.env.OFFER_DEFAULT_TTL || '60000', 10),
    offerMaxTtl: parseInt(process.env.OFFER_MAX_TTL || '86400000', 10),
    offerMinTtl: parseInt(process.env.OFFER_MIN_TTL || '60000', 10),
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL || '60000', 10),
    maxOffersPerRequest: parseInt(process.env.MAX_OFFERS_PER_REQUEST || '100', 10),
    maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || '100', 10)
  };
}
