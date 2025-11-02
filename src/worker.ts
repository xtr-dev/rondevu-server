import { createApp } from './app.ts';
import { KVStorage } from './storage/kv.ts';

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
  SESSIONS: KVNamespace;
  SESSION_TIMEOUT?: string;
  CORS_ORIGINS?: string;
}

/**
 * Cloudflare Workers fetch handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize KV storage
    const storage = new KVStorage(env.SESSIONS);

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
};
