import { defaultConfig } from './defaults';
import type { Config, StorageMode } from './schema';

export interface BootstrapConfig {
  storageMode: StorageMode;
  database: Config['database'];
  security: {
    masterKey: string;
    jwtSecret: string;
    sessionSecret: string;
  };
  api: {
    host: string;
    port: number;
  };
}

/**
 * Load bootstrap configuration from environment variables.
 * Only reads the vars needed before the database is available.
 */
export function loadBootstrapConfig(): BootstrapConfig {
  const storageMode = (process.env.STORAGE_MODE || 'external') as StorageMode;

  return {
    storageMode,
    database: {
      url: process.env.DATABASE_URL || defaultConfig.database!.url!,
      dataDir: process.env.DATA_DIR || defaultConfig.database?.dataDir || '~/.octipus/data',
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
      idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000', 10),
    },
    security: {
      masterKey: process.env.MASTER_KEY || '',
      jwtSecret: process.env.JWT_SECRET || '',
      sessionSecret: process.env.SESSION_SECRET || '',
    },
    api: {
      host: process.env.API_HOST || process.env.HOST || defaultConfig.api!.host!,
      port: parseInt(process.env.API_PORT || process.env.PORT || '3000', 10),
    },
  };
}
