import { Context, Next } from 'hono';
import { validateCredentials } from '../crypto.ts';

/**
 * Authentication middleware for Rondevu
 * Validates Bearer token in format: {peerId}:{encryptedSecret}
 */
export function createAuthMiddleware(authSecret: string) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    // Expect format: Bearer {peerId}:{secret}
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return c.json({ error: 'Invalid Authorization header format. Expected: Bearer {peerId}:{secret}' }, 401);
    }

    const credentials = parts[1].split(':');
    if (credentials.length !== 2) {
      return c.json({ error: 'Invalid credentials format. Expected: {peerId}:{secret}' }, 401);
    }

    const [peerId, encryptedSecret] = credentials;

    // Validate credentials (async operation)
    const isValid = await validateCredentials(peerId, encryptedSecret, authSecret);
    if (!isValid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Attach peer ID to context for use in handlers
    c.set('peerId', peerId);

    await next();
  };
}

/**
 * Helper to get authenticated peer ID from context
 */
export function getAuthenticatedPeerId(c: Context): string {
  const peerId = c.get('peerId');
  if (!peerId) {
    throw new Error('No authenticated peer ID in context');
  }
  return peerId;
}
