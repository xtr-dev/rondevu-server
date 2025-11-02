/**
 * Application configuration
 * Reads from environment variables with sensible defaults
 */
export interface Config {
  port: number;
  storageType: 'sqlite' | 'memory';
  storagePath: string;
  sessionTimeout: number;
  corsOrigins: string[];
}

/**
 * Loads configuration from environment variables
 */
export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    storageType: (process.env.STORAGE_TYPE || 'sqlite') as 'sqlite' | 'memory',
    storagePath: process.env.STORAGE_PATH || ':memory:',
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || '300000', 10),
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
      : ['*'],
  };
}
