import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Storage } from './storage/types.ts';

export interface AppConfig {
  sessionTimeout: number;
  corsOrigins: string[];
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
   * Lists all topics with their unanswered session counts (paginated)
   * Query params: page (default: 1), limit (default: 100, max: 1000)
   */
  app.get('/', async (c) => {
    try {
      const origin = c.req.header('Origin') || c.req.header('origin') || 'unknown';
      const page = parseInt(c.req.query('page') || '1', 10);
      const limit = parseInt(c.req.query('limit') || '100', 10);

      const result = await storage.listTopics(origin, page, limit);

      return c.json(result);
    } catch (err) {
      console.error('Error listing topics:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /:topic/sessions
   * Lists all unanswered sessions for a topic
   */
  app.get('/:topic/sessions', async (c) => {
    try {
      const origin = c.req.header('Origin') || c.req.header('origin') || 'unknown';
      const topic = c.req.param('topic');

      if (!topic) {
        return c.json({ error: 'Missing required parameter: topic' }, 400);
      }

      if (topic.length > 256) {
        return c.json({ error: 'Topic string must be 256 characters or less' }, 400);
      }

      const sessions = await storage.listSessionsByTopic(origin, topic);

      return c.json({
        sessions: sessions.map(s => ({
          code: s.code,
          info: s.info,
          offer: s.offer,
          offerCandidates: s.offerCandidates,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
        })),
      });
    } catch (err) {
      console.error('Error listing sessions:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /:topic/offer
   * Creates a new offer and returns a unique session code
   * Body: { info: string, offer: string }
   */
  app.post('/:topic/offer', async (c) => {
    try {
      const origin = c.req.header('Origin') || c.req.header('origin') || 'unknown';
      const topic = c.req.param('topic');
      const body = await c.req.json();
      const { info, offer } = body;

      if (!topic || typeof topic !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: topic' }, 400);
      }

      if (topic.length > 256) {
        return c.json({ error: 'Topic string must be 256 characters or less' }, 400);
      }

      if (!info || typeof info !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: info' }, 400);
      }

      if (info.length > 1024) {
        return c.json({ error: 'Info string must be 1024 characters or less' }, 400);
      }

      if (!offer || typeof offer !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: offer' }, 400);
      }

      const expiresAt = Date.now() + config.sessionTimeout;
      const code = await storage.createSession(origin, topic, info, offer, expiresAt);

      return c.json({ code }, 200);
    } catch (err) {
      console.error('Error creating offer:', err);
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
      const origin = c.req.header('Origin') || c.req.header('origin') || 'unknown';
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

      const session = await storage.getSession(code, origin);

      if (!session) {
        return c.json({ error: 'Session not found, expired, or origin mismatch' }, 404);
      }

      if (answer) {
        await storage.updateSession(code, origin, { answer });
      }

      if (candidate) {
        if (side === 'offerer') {
          const updatedCandidates = [...session.offerCandidates, candidate];
          await storage.updateSession(code, origin, { offerCandidates: updatedCandidates });
        } else {
          const updatedCandidates = [...session.answerCandidates, candidate];
          await storage.updateSession(code, origin, { answerCandidates: updatedCandidates });
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
   * Polls for session data (offer, answer, ICE candidates)
   * Body: { code: string, side: 'offerer' | 'answerer' }
   */
  app.post('/poll', async (c) => {
    try {
      const origin = c.req.header('Origin') || c.req.header('origin') || 'unknown';
      const body = await c.req.json();
      const { code, side } = body;

      if (!code || typeof code !== 'string') {
        return c.json({ error: 'Missing or invalid required parameter: code' }, 400);
      }

      if (!side || (side !== 'offerer' && side !== 'answerer')) {
        return c.json({ error: 'Invalid or missing parameter: side (must be "offerer" or "answerer")' }, 400);
      }

      const session = await storage.getSession(code, origin);

      if (!session) {
        return c.json({ error: 'Session not found, expired, or origin mismatch' }, 404);
      }

      if (side === 'offerer') {
        return c.json({
          answer: session.answer || null,
          answerCandidates: session.answerCandidates,
        });
      } else {
        return c.json({
          offer: session.offer,
          offerCandidates: session.offerCandidates,
        });
      }
    } catch (err) {
      console.error('Error polling session:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /health
   * Health check endpoint
   */
  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: Date.now() });
  });

  return app;
}
