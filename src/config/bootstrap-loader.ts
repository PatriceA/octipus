import type { Config } from './schema';
import { defaultConfig } from './defaults';

export interface BootstrapConfig {
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
  return {
    database: {
      url: process.env.DATABASE_URL || defaultConfig.database!.url!,
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
