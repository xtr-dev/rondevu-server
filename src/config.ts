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
  maxSdpSize: number;
  maxCandidateSize: number;
  maxCandidateDepth: number;
  maxCandidatesPerRequest: number;
  maxTotalOperations: number;
  timestampMaxAge: number; // Max age for timestamps (replay protection)
  timestampMaxFuture: number; // Max future tolerance for timestamps (clock skew)
  masterEncryptionKey: string; // 64-char hex string for encrypting secrets (32 bytes)
}

/**
 * Loads configuration from environment variables
 */
export function loadConfig(): Config {
  // Master encryption key for secret storage
  // CRITICAL: Set MASTER_ENCRYPTION_KEY in production to a secure random value
  let masterEncryptionKey = process.env.MASTER_ENCRYPTION_KEY;

  if (!masterEncryptionKey) {
    // SECURITY: Fail fast unless explicitly in development mode
    // Default to production-safe behavior if NODE_ENV is unset
    const isDevelopment = process.env.NODE_ENV === 'development';

    if (!isDevelopment) {
      throw new Error(
        'MASTER_ENCRYPTION_KEY environment variable must be set. ' +
        'Generate with: openssl rand -hex 32\n' +
        'For development only, set NODE_ENV=development to use insecure dev key.'
      );
    }

    // Use deterministic key ONLY in explicit development mode
    // WARNING: DO NOT USE THIS IN PRODUCTION - only for local development
    console.error('⚠️  WARNING: Using insecure deterministic development key');
    console.error('⚠️  ONLY use NODE_ENV=development for local development');
    console.error('⚠️  Generate production key with: openssl rand -hex 32');
    // Random-looking dev key (not ASCII-readable to prevent accidental production use)
    masterEncryptionKey = 'a3f8b9c2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2';
  }

  // Validate master encryption key format
  // NOTE: Using regex here is safe since this runs at startup, not during request processing
  if (masterEncryptionKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(masterEncryptionKey)) {
    throw new Error('MASTER_ENCRYPTION_KEY must be 64-character hex string (32 bytes). Generate with: openssl rand -hex 32');
  }

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
    storageType: (process.env.STORAGE_TYPE || 'sqlite') as 'sqlite' | 'memory',
    storagePath: process.env.STORAGE_PATH || ':memory:',
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
      : ['*'],
    version: process.env.VERSION || 'unknown',
    offerDefaultTtl: parsePositiveInt(process.env.OFFER_DEFAULT_TTL, '60000', 'OFFER_DEFAULT_TTL', 1000),
    offerMaxTtl: parsePositiveInt(process.env.OFFER_MAX_TTL, '86400000', 'OFFER_MAX_TTL', 1000),
    offerMinTtl: parsePositiveInt(process.env.OFFER_MIN_TTL, '60000', 'OFFER_MIN_TTL', 1000),
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
    masterEncryptionKey,
  };

  return config;
}
