import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Storage } from './storage/types.ts';
import { Config } from './config.ts';
import { handleRpc, RpcRequest } from './rpc.ts';

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
    allowHeaders: ['Content-Type', 'Origin', 'X-Username', 'X-Timestamp', 'X-Signature', 'X-Public-Key'],
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
   * RPC endpoint - accepts batch method calls only
   */
  app.post('/rpc', async (c) => {
    try {
      const body = await c.req.json();

      // Only accept batch arrays
      if (!Array.isArray(body)) {
        return c.json([{
          success: false,
          error: 'Request must be an array of RPC calls',
          errorCode: 'INVALID_PARAMS'
        }], 400);
      }

      const requests: RpcRequest[] = body;

      // Validate requests
      if (requests.length === 0) {
        return c.json([{
          success: false,
          error: 'Empty request array',
          errorCode: 'INVALID_PARAMS'
        }], 400);
      }

      if (requests.length > config.maxBatchSize) {
        return c.json([{
          success: false,
          error: `Too many requests in batch (max ${config.maxBatchSize})`,
          errorCode: 'INVALID_PARAMS'
        }], 400);
      }

      // Handle RPC (pass context for auth headers)
      const responses = await handleRpc(requests, c, storage, config);

      // Always return array
      return c.json(responses, 200);
    } catch (err) {
      console.error('RPC error:', err);

      // Distinguish between JSON parse errors and validation errors
      const errorMsg = err instanceof SyntaxError
        ? 'Invalid JSON in request body'
        : 'Request must be valid JSON array';

      return c.json([{
        success: false,
        error: errorMsg,
        errorCode: 'INVALID_PARAMS'
      }], 400);
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
