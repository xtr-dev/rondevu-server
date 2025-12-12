import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import { handleRpc, RpcRequest } from './rpc.ts';

// Constants
const MAX_BATCH_SIZE = 100;

/**
 * Creates the Hono application with RPC interface
 */
export function createApp(storage: Storage, config: Config) {
  const app = new Hono();

  // Enable CORS
  app.use('/*', cors({
    origin: (origin) => {
      if (config.corsOrigins.length === 1 && config.corsOrigins[0] === '*') {
        return origin;
      }
      if (config.corsOrigins.includes(origin)) {
        return origin;
      }
      return config.corsOrigins[0];
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Origin'],
    exposeHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 86400,
  }));

  // Root endpoint - server info
  app.get('/', (c) => {
    return c.json({
      version: config.version,
      name: 'Rondevu',
      description: 'WebRTC signaling with RPC interface and Ed25519 authentication',
    }, 200);
  });

  // Health check
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: Date.now(),
      version: config.version,
    }, 200);
  });

  /**
   * POST /rpc
   * RPC endpoint - accepts single or batch method calls
   */
  app.post('/rpc', async (c) => {
    try {
      const body = await c.req.json();

      // Support both single request and batch array
      const requests: RpcRequest[] = Array.isArray(body) ? body : [body];

      // Validate requests
      if (requests.length === 0) {
        return c.json({ error: 'Empty request array' }, 400);
      }

      if (requests.length > MAX_BATCH_SIZE) {
        return c.json({ error: `Too many requests in batch (max ${MAX_BATCH_SIZE})` }, 400);
      }

      // Handle RPC
      const responses = await handleRpc(requests, storage, config);

      // Return single response or array based on input
      return c.json(Array.isArray(body) ? responses : responses[0], 200);
    } catch (err) {
      console.error('RPC error:', err);
      return c.json({
        success: false,
        error: 'Invalid request format',
      }, 400);
    }
  });

  // 404 for all other routes
  app.all('*', (c) => {
    return c.json({
      error: 'Not found. Use POST /rpc for all API calls.',
    }, 404);
  });

  return app;
}
