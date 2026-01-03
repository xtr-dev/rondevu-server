import { createApp } from './app.ts';
import { D1Storage } from './storage/d1.ts';
import { buildWorkerConfig, runCleanup } from './config.ts';

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
  DB: D1Database;
  MASTER_ENCRYPTION_KEY: string;
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
    if (!env.MASTER_ENCRYPTION_KEY || env.MASTER_ENCRYPTION_KEY.length !== 64) {
      return new Response('MASTER_ENCRYPTION_KEY must be 64-char hex string', { status: 500 });
    }

    const storage = new D1Storage(env.DB, env.MASTER_ENCRYPTION_KEY);
    const config = buildWorkerConfig(env);
    const app = createApp(storage, config);

    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const storage = new D1Storage(env.DB, env.MASTER_ENCRYPTION_KEY);
    const now = Date.now();

    try {
      const result = await runCleanup(storage, now);
      const total = result.offers + result.credentials + result.rateLimits + result.nonces;
      if (total > 0) {
        console.log(`Cleanup: ${result.offers} offers, ${result.credentials} credentials, ${result.rateLimits} rate limits, ${result.nonces} nonces`);
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  },
};
