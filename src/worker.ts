import { createApp } from './app.ts';
import { D1Storage } from './storage/d1.ts';

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
  DB: D1Database;
  OFFER_TIMEOUT?: string;
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

    // Parse configuration
    const offerTimeout = env.OFFER_TIMEOUT
      ? parseInt(env.OFFER_TIMEOUT, 10)
      : 60000; // 1 minute default

    const corsOrigins = env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',').map(o => o.trim())
      : ['*'];

    // Create Hono app
    const app = createApp(storage, {
      offerTimeout,
      corsOrigins,
      version: env.VERSION || 'unknown',
    });

    // Handle request
    return app.fetch(request, env, ctx);
  },

  /**
   * Scheduled handler for cron triggers
   * Runs every minute to clean up expired offers
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const storage = new D1Storage(env.DB);
    const now = Date.now();

    try {
      // Delete expired offers using the storage method
      const deletedCount = await storage.cleanupExpiredOffers();

      console.log(`Cleaned up ${deletedCount} expired offers at ${new Date(now).toISOString()}`);
    } catch (error) {
      console.error('Error cleaning up offers:', error);
    }
  },
};
