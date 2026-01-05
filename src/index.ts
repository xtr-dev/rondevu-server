import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig, runCleanup } from './config.ts';
import { createStorage } from './storage/factory.ts';
import { Storage } from './storage/types.ts';

async function main() {
  const config = loadConfig();

  console.log('Starting Rondevu server...');
  console.log('Configuration:', {
    port: config.port,
    storageType: config.storageType,
    storagePath: config.storageType === 'sqlite' ? config.storagePath : undefined,
    databaseUrl: config.databaseUrl ? '[configured]' : undefined,
    dbPoolSize: ['mysql', 'postgres'].includes(config.storageType) ? config.dbPoolSize : undefined,
    offerDefaultTtl: `${config.offerDefaultTtl}ms`,
    cleanupInterval: `${config.cleanupInterval}ms`,
    version: config.version,
  });

  const storage: Storage = await createStorage({
    type: config.storageType,
    sqlitePath: config.storagePath,
    connectionString: config.databaseUrl,
    poolSize: config.dbPoolSize,
  });
  console.log(`Using ${config.storageType} storage`);

  // Periodic cleanup
  const cleanupTimer = setInterval(async () => {
    try {
      const result = await runCleanup(storage, Date.now());
      const total = result.offers + result.rateLimits + result.nonces;
      if (total > 0) {
        console.log(`Cleanup: ${result.offers} offers, ${result.rateLimits} rate limits, ${result.nonces} nonces`);
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
