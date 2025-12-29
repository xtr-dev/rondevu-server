import { createApp } from './app.ts';
import { D1Storage } from './storage/d1.ts';
import { Config } from './config.ts';

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
  DB: D1Database;
  MASTER_ENCRYPTION_KEY: string; // 64-char hex string for encrypting secrets
  OFFER_DEFAULT_TTL?: string;
  OFFER_MAX_TTL?: string;
  OFFER_MIN_TTL?: string;
  MAX_OFFERS_PER_REQUEST?: string;
  MAX_BATCH_SIZE?: string;
  CORS_ORIGINS?: string;
  VERSION?: string;
}

/**
 * Cloudflare Workers fetch handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Validate master encryption key
    if (!env.MASTER_ENCRYPTION_KEY || env.MASTER_ENCRYPTION_KEY.length !== 64) {
      return new Response('MASTER_ENCRYPTION_KEY environment variable must be 64-char hex string (32 bytes)', { status: 500 });
    }

    // Initialize D1 storage with encryption key
    const storage = new D1Storage(env.DB, env.MASTER_ENCRYPTION_KEY);

    // Build config from environment
    const config: Config = {
      port: 0, // Not used in Workers
      storageType: 'sqlite', // D1 is SQLite-compatible
      storagePath: '', // Not used with D1
      corsOrigins: env.CORS_ORIGINS
        ? env.CORS_ORIGINS.split(',').map(o => o.trim())
        : ['*'],
      version: env.VERSION || 'unknown',
      offerDefaultTtl: env.OFFER_DEFAULT_TTL ? parseInt(env.OFFER_DEFAULT_TTL, 10) : 60000,
      offerMaxTtl: env.OFFER_MAX_TTL ? parseInt(env.OFFER_MAX_TTL, 10) : 86400000,
      offerMinTtl: env.OFFER_MIN_TTL ? parseInt(env.OFFER_MIN_TTL, 10) : 60000,
      cleanupInterval: 60000, // Not used in Workers (scheduled handler instead)
      maxOffersPerRequest: env.MAX_OFFERS_PER_REQUEST ? parseInt(env.MAX_OFFERS_PER_REQUEST, 10) : 100,
      maxBatchSize: env.MAX_BATCH_SIZE ? parseInt(env.MAX_BATCH_SIZE, 10) : 100,
      maxSdpSize: 64 * 1024,
      maxCandidateSize: 4 * 1024,
      maxCandidateDepth: 10,
      maxCandidatesPerRequest: 100,
      maxTotalOperations: 1000,
      timestampMaxAge: 300000, // 5 minutes
      timestampMaxFuture: 60000, // 1 minute
      masterEncryptionKey: env.MASTER_ENCRYPTION_KEY
    };

    // Create Hono app
    const app = createApp(storage, config);

    // Handle request
    return app.fetch(request, env, ctx);
  },

  /**
   * Scheduled handler for cron triggers
   * Runs periodically to clean up expired offers
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const storage = new D1Storage(env.DB, env.MASTER_ENCRYPTION_KEY);
    const now = Date.now();

    try {
      // Delete expired offers
      const deletedCount = await storage.deleteExpiredOffers(now);

      console.log(`Cleaned up ${deletedCount} expired offers at ${new Date(now).toISOString()}`);
    } catch (error) {
      console.error('Error cleaning up offers:', error);
    }
  },
};
