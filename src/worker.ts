import { createApp } from './app.ts';
import { D1Storage } from './storage/d1.ts';
import { buildWorkerConfig, runCleanup } from './config.ts';

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
  DB: D1Database;
  OFFER_DEFAULT_TTL?: string;
  OFFER_MAX_TTL?: string;
  OFFER_MIN_TTL?: string;
  MAX_OFFERS_PER_REQUEST?: string;
  MAX_BATCH_SIZE?: string;
  CORS_ORIGINS?: string;
  VERSION?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const storage = new D1Storage(env.DB);
    const config = buildWorkerConfig(env);
    const app = createApp(storage, config);

    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const storage = new D1Storage(env.DB);
    const now = Date.now();

    try {
      const result = await runCleanup(storage, now);
      const total = result.offers + result.rateLimits + result.nonces;
      if (total > 0) {
        console.log(`Cleanup: ${result.offers} offers, ${result.rateLimits} rate limits, ${result.nonces} nonces`);
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  },
};
