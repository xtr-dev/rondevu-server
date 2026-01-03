import { Storage } from './types.ts';

/**
 * Supported storage backend types
 */
export type StorageType = 'memory' | 'sqlite' | 'mysql' | 'postgres';

/**
 * Configuration for creating a storage backend
 */
export interface StorageConfig {
  type: StorageType;
  /** Master encryption key for secrets (64-char hex string) */
  masterEncryptionKey: string;
  /** SQLite database path (default: ':memory:') */
  sqlitePath?: string;
  /** Connection string for MySQL/PostgreSQL */
  connectionString?: string;
  /** Connection pool size for MySQL/PostgreSQL (default: 10) */
  poolSize?: number;
}

/**
 * Creates a storage backend based on configuration
 * Uses dynamic imports to avoid loading unused dependencies
 */
export async function createStorage(config: StorageConfig): Promise<Storage> {
  switch (config.type) {
    case 'memory': {
      const { MemoryStorage } = await import('./memory.ts');
      return new MemoryStorage(config.masterEncryptionKey);
    }

    case 'sqlite': {
      const { SQLiteStorage } = await import('./sqlite.ts');
      return new SQLiteStorage(
        config.sqlitePath || ':memory:',
        config.masterEncryptionKey
      );
    }

    case 'mysql': {
      if (!config.connectionString) {
        throw new Error('MySQL storage requires DATABASE_URL connection string');
      }
      const { MySQLStorage } = await import('./mysql.ts');
      return MySQLStorage.create(
        config.connectionString,
        config.masterEncryptionKey,
        config.poolSize || 10
      );
    }

    case 'postgres': {
      if (!config.connectionString) {
        throw new Error('PostgreSQL storage requires DATABASE_URL connection string');
      }
      const { PostgreSQLStorage } = await import('./postgres.ts');
      return PostgreSQLStorage.create(
        config.connectionString,
        config.masterEncryptionKey,
        config.poolSize || 10
      );
    }

    default:
      throw new Error(`Unsupported storage type: ${config.type}`);
  }
}
