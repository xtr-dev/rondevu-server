import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { SQLiteStorage } from './storage/sqlite.ts';
import { Storage } from './storage/types.ts';

/**
 * Main entry point for the standalone Node.js server
 */
async function main() {
  const config = loadConfig();

  console.log('Starting Rondevu server...');
  console.log('Configuration:', {
    port: config.port,
    storageType: config.storageType,
    storagePath: config.storagePath,
    offerDefaultTtl: `${config.offerDefaultTtl}ms`,
    offerMaxTtl: `${config.offerMaxTtl}ms`,
    offerMinTtl: `${config.offerMinTtl}ms`,
    cleanupInterval: `${config.cleanupInterval}ms`,
    maxOffersPerRequest: config.maxOffersPerRequest,
    corsOrigins: config.corsOrigins,
    version: config.version,
  });

  let storage: Storage;

  if (config.storageType === 'sqlite') {
    storage = new SQLiteStorage(config.storagePath, config.masterEncryptionKey);
    console.log('Using SQLite storage');
  } else {
    throw new Error('Unsupported storage type');
  }

  // Start periodic cleanup of expired entries
  const cleanupInterval = setInterval(async () => {
    try {
      const now = Date.now();

      // Clean up expired offers
      const deletedOffers = await storage.deleteExpiredOffers(now);
      if (deletedOffers > 0) {
        console.log(`Cleanup: Deleted ${deletedOffers} expired offer(s)`);
      }

      // Clean up expired credentials
      const deletedCredentials = await storage.deleteExpiredCredentials(now);
      if (deletedCredentials > 0) {
        console.log(`Cleanup: Deleted ${deletedCredentials} expired credential(s)`);
      }

      // Clean up expired rate limits
      const deletedRateLimits = await storage.deleteExpiredRateLimits(now);
      if (deletedRateLimits > 0) {
        console.log(`Cleanup: Deleted ${deletedRateLimits} expired rate limit(s)`);
      }

      // Clean up expired nonces (replay protection)
      const deletedNonces = await storage.deleteExpiredNonces(now);
      if (deletedNonces > 0) {
        console.log(`Cleanup: Deleted ${deletedNonces} expired nonce(s)`);
      }
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  }, config.cleanupInterval);

  const app = createApp(storage, config);

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  console.log(`Server running on http://localhost:${config.port}`);
  console.log('Ready to accept connections');

  // Graceful shutdown handler
  const shutdown = async () => {
    console.log('\nShutting down gracefully...');
    clearInterval(cleanupInterval);
    await storage.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
