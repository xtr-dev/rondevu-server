import { createApp } from './app.ts';
import { D1Storage } from './storage/d1.ts';

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
  DB: D1Database;
  SESSION_TIMEOUT?: string;
  CORS_ORIGINS?: string;
}

/**
 * Cloudflare Workers fetch handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize D1 storage
    const storage = new D1Storage(env.DB);

    // Parse configuration
    const sessionTimeout = env.SESSION_TIMEOUT
      ? parseInt(env.SESSION_TIMEOUT, 10)
      : 300000; // 5 minutes default

    const corsOrigins = env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',').map(o => o.trim())
      : ['*'];

    // Create Hono app
    const app = createApp(storage, {
      sessionTimeout,
      corsOrigins,
    });

    // Handle request
    return app.fetch(request, env, ctx);
  },

  /**
   * Scheduled handler for cron triggers
   * Runs every 5 minutes to clean up expired sessions
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const storage = new D1Storage(env.DB);
    const now = Date.now();

    try {
      // Delete expired sessions
      await storage.db
        .prepare('DELETE FROM sessions WHERE expires_at < ?')
        .bind(now)
        .run();

      console.log(`Cleaned up expired sessions at ${new Date(now).toISOString()}`);
    } catch (error) {
      console.error('Error cleaning up sessions:', error);
    }
  },
};
