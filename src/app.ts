import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Storage } from './storage/types.ts';
import type { Context } from 'hono';

export interface AppConfig {
  offerTimeout: number;
  corsOrigins: string[];
  version?: string;
}

/**
 * Creates the Hono application with WebRTC signaling endpoints
 */
export function createApp(storage: Storage, config: AppConfig) {
  const app = new Hono();

  // Enable CORS with dynamic origin handling
  app.use('/*', cors({
    origin: (origin) => {
      // If no origin restrictions (wildcard), allow any origin
      if (config.corsOrigins.length === 1 && config.corsOrigins[0] === '*') {
        return origin;
      }
      // Otherwise check if origin is in allowed list
      if (config.corsOrigins.includes(origin)) {
        return origin;
      }
      // Default to first allowed origin
      return config.corsOrigins[0];
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Origin'],
    exposeHeaders: ['Content-Type'],
    maxAge: 600,
    credentials: true,
  }));

  /**
   * GET /
   * Returns server version information
   */
  app.get('/', (c) => {
    return c.json({
      version: config.version || 'unknown'
    });
  });

  /**
   * GET /health
   * Health check endpoint with version
   */
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: Date.now(),
      version: config.version || 'unknown'
    });
  });

  /**
   * POST /offer
   * Creates a new offer and returns a unique code
   * Body: { peerId: string, offer: string, code?: string }
   */
  app.post('/offer', async (c) => {
    try {
      const body = await c.req.json();
      const { peerId, offer, code: customCode } = body;

      if (!peerId || typeof peerId !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: peerId' }, 400);
      }

      if (peerId.length > 1024) {
        return c.json({ error: 'PeerId string must be 1024 characters or less' }, 400);
      }

      if (!offer || typeof offer !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: offer' }, 400);
      }

      const expiresAt = Date.now() + config.offerTimeout;
      const code = await storage.createOffer(peerId, offer, expiresAt, customCode);

      return c.json({ code }, 200);
    } catch (err) {
      console.error('Error creating offer:', err);

      // Check if it's a code clash error
      if (err instanceof Error && err.message.includes('already exists')) {
        return c.json({ error: err.message }, 409);
      }

      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /answer
   * Responds to an existing offer or sends ICE candidates
   * Body: { code: string, answer?: string, candidate?: string, side: 'offerer' | 'answerer' }
   */
  app.post('/answer', async (c) => {
    try {
      const body = await c.req.json();
      const { code, answer, candidate, side } = body;

      if (!code || typeof code !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: code' }, 400);
      }

      if (!side || (side !== 'offerer' && side !== 'answerer')) {
        return c.json({ error: 'Invalid or missing parameter: side (must be "offerer" or "answerer")' }, 400);
      }

      if (!answer && !candidate) {
        return c.json({ error: 'Missing required parameter: answer or candidate' }, 400);
      }

      if (answer && candidate) {
        return c.json({ error: 'Cannot provide both answer and candidate' }, 400);
      }

      const offer = await storage.getOffer(code);

      if (!offer) {
        return c.json({ error: 'Offer not found or expired' }, 404);
      }

      if (answer) {
        await storage.updateOffer(code, { answer });
      }

      if (candidate) {
        if (side === 'offerer') {
          const updatedCandidates = [...offer.offerCandidates, candidate];
          await storage.updateOffer(code, { offerCandidates: updatedCandidates });
        } else {
          const updatedCandidates = [...offer.answerCandidates, candidate];
          await storage.updateOffer(code, { answerCandidates: updatedCandidates });
        }
      }

      return c.json({ success: true }, 200);
    } catch (err) {
      console.error('Error handling answer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /poll
   * Polls for offer data (offer, answer, ICE candidates)
   * Body: { code: string, side: 'offerer' | 'answerer' }
   */
  app.post('/poll', async (c) => {
    try {
      const body = await c.req.json();
      const { code, side } = body;

      if (!code || typeof code !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: code' }, 400);
      }

      if (!side || (side !== 'offerer' && side !== 'answerer')) {
        return c.json({ error: 'Invalid or missing parameter: side (must be "offerer" or "answerer")' }, 400);
      }

      const offer = await storage.getOffer(code);

      if (!offer) {
        return c.json({ error: 'Offer not found or expired' }, 404);
      }

      if (side === 'offerer') {
        return c.json({
          answer: offer.answer || null,
          answerCandidates: offer.answerCandidates,
        });
      } else {
        return c.json({
          offer: offer.offer,
          offerCandidates: offer.offerCandidates,
        });
      }
    } catch (err) {
      console.error('Error polling offer:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return app;
}
