import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig, runCleanup } from './config.ts';
import { SQLiteStorage } from './storage/sqlite.ts';
import { Storage } from './storage/types.ts';

async function main() {
  const config = loadConfig();

  console.log('Starting Rondevu server...');
  console.log('Configuration:', {
    port: config.port,
    storageType: config.storageType,
    storagePath: config.storagePath,
    offerDefaultTtl: `${config.offerDefaultTtl}ms`,
    cleanupInterval: `${config.cleanupInterval}ms`,
    version: config.version,
  });

  let storage: Storage;
  if (config.storageType === 'sqlite') {
    storage = new SQLiteStorage(config.storagePath, config.masterEncryptionKey);
    console.log('Using SQLite storage');
  } else {
    throw new Error('Unsupported storage type');
  }

  // Periodic cleanup
  const cleanupTimer = setInterval(async () => {
    try {
      const result = await runCleanup(storage, Date.now());
      const total = result.offers + result.credentials + result.rateLimits + result.nonces;
      if (total > 0) {
        console.log(`Cleanup: ${result.offers} offers, ${result.credentials} credentials, ${result.rateLimits} rate limits, ${result.nonces} nonces`);
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
    clearInterval(cleanupTimer);
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
