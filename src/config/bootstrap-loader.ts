import { defaultConfig } from './defaults';
import type { Config, StorageMode } from './schema';

export interface BootstrapConfig {
  storageMode: StorageMode;
  database: Config['database'];
  redis: Config['redis'];
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
 * Only reads the vars needed before DB/Redis are available.
 */
export function loadBootstrapConfig(): BootstrapConfig {
  const storageMode = (process.env.STORAGE_MODE || 'external') as StorageMode;

  return {
    storageMode,
    database: {
      url: process.env.DATABASE_URL || defaultConfig.database!.url!,
      dataDir: process.env.DATA_DIR || defaultConfig.database?.dataDir || '~/.assistant/data',
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
      idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000', 10),
    },
    redis: {
      url: process.env.REDIS_URL || defaultConfig.redis!.url!,
      keyPrefix: process.env.REDIS_KEY_PREFIX || defaultConfig.redis!.keyPrefix!,
      maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
      retryDelay: parseInt(process.env.REDIS_RETRY_DELAY || '1000', 10),
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
