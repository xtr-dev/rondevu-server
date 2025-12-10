import { Context, Next } from 'hono';
import { verifyEd25519Signature, validateAuthMessage } from '../crypto.ts';
import { Storage } from '../storage/types.ts';

/**
 * Authentication middleware for Rondevu - Ed25519 signature-based
 * Verifies username ownership via Ed25519 signatures
 *
 * For POST requests: Extracts username, signature, message from request body
 * For GET requests: Extracts username, signature, message from query params
 */
export function createAuthMiddleware(storage: Storage) {
  return async (c: Context, next: Next) => {
    let username: string | undefined;
    let signature: string | undefined;
    let message: string | undefined;

    // Determine if this is a GET or POST request
    if (c.req.method === 'GET') {
      // Extract from query params
      const query = c.req.query();
      username = query.username;
      signature = query.signature;
      message = query.message;
    } else {
      // Extract from request body
      try {
        const body = await c.req.json();
        username = body.username;
        signature = body.signature;
        message = body.message;
      } catch (err) {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
    }

    // Validate presence of auth fields
    if (!username || !signature || !message) {
      return c.json({
        error: 'Missing authentication fields: username, signature, and message are required'
      }, 401);
    }

    // Get username record to fetch public key
    const usernameRecord = await storage.getUsername(username);
    if (!usernameRecord) {
      return c.json({
        error: `Username "${username}" is not claimed. Please claim username first.`
      }, 401);
    }

    // Verify Ed25519 signature
    const isValid = await verifyEd25519Signature(
      usernameRecord.publicKey,
      signature,
      message
    );
    if (!isValid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Validate message format and timestamp
    const validation = validateAuthMessage(username, message);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 401);
    }

    // Store authenticated username in context
    c.set('username', username);

    await next();
  };
}

/**
 * Helper to get authenticated username from context
 */
export function getAuthenticatedUsername(c: Context): string {
  const username = c.get('username');
  if (!username) {
    throw new Error('No authenticated username in context');
  }
  return username;
}
