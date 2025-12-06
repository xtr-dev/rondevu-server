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
    storage = new SQLiteStorage(config.storagePath);
    console.log('Using SQLite storage');
  } else {
    throw new Error('Unsupported storage type');
  }

  // Start periodic cleanup of expired offers
  const cleanupInterval = setInterval(async () => {
    try {
      const now = Date.now();
      const deleted = await storage.deleteExpiredOffers(now);
      if (deleted > 0) {
        console.log(`Cleanup: Deleted ${deleted} expired offer(s)`);
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
