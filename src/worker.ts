import { createApp } from './app.ts';
import { D1Storage } from './storage/d1.ts';
import { generateSecretKey } from './crypto.ts';
import { Config } from './config.ts';

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
  DB: D1Database;
  AUTH_SECRET?: string;
  OFFER_DEFAULT_TTL?: string;
  OFFER_MAX_TTL?: string;
  OFFER_MIN_TTL?: string;
  MAX_OFFERS_PER_REQUEST?: string;
  MAX_TOPICS_PER_OFFER?: string;
  CORS_ORIGINS?: string;
  VERSION?: string;
}

/**
 * Cloudflare Workers fetch handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize D1 storage
    const storage = new D1Storage(env.DB);

    // Generate or use provided auth secret
    const authSecret = env.AUTH_SECRET || generateSecretKey();

    // Build config from environment
    const config: Config = {
      port: 0, // Not used in Workers
      storageType: 'sqlite', // D1 is SQLite-compatible
      storagePath: '', // Not used with D1
      corsOrigins: env.CORS_ORIGINS
        ? env.CORS_ORIGINS.split(',').map(o => o.trim())
        : ['*'],
      version: env.VERSION || 'unknown',
      authSecret,
      offerDefaultTtl: env.OFFER_DEFAULT_TTL ? parseInt(env.OFFER_DEFAULT_TTL, 10) : 60000,
      offerMaxTtl: env.OFFER_MAX_TTL ? parseInt(env.OFFER_MAX_TTL, 10) : 86400000,
      offerMinTtl: env.OFFER_MIN_TTL ? parseInt(env.OFFER_MIN_TTL, 10) : 60000,
      cleanupInterval: 60000, // Not used in Workers (scheduled handler instead)
      maxOffersPerRequest: env.MAX_OFFERS_PER_REQUEST ? parseInt(env.MAX_OFFERS_PER_REQUEST, 10) : 100,
      maxTopicsPerOffer: env.MAX_TOPICS_PER_OFFER ? parseInt(env.MAX_TOPICS_PER_OFFER, 10) : 50,
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
    const storage = new D1Storage(env.DB);
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
