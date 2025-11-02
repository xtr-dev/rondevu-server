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
    sessionTimeout: `${config.sessionTimeout}ms`,
    corsOrigins: config.corsOrigins,
  });

  let storage: Storage;

  if (config.storageType === 'sqlite') {
    storage = new SQLiteStorage(config.storagePath);
    console.log('Using SQLite storage');
  } else {
    throw new Error('Unsupported storage type');
  }

  const app = createApp(storage, {
    sessionTimeout: config.sessionTimeout,
    corsOrigins: config.corsOrigins,
  });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  console.log(`Server running on http://localhost:${config.port}`);

  process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    await storage.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...');
    await storage.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
