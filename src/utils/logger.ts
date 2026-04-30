import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';
const logFormat = process.env.LOG_FORMAT || 'pretty';

const transport = logFormat === 'pretty'
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger = pino({
  level: logLevel,
  transport,
  base: {
    service: 'octipus',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

// Specialized loggers for different components
export const coreLogger = createChildLogger({ component: 'core' });
export const dbLogger = createChildLogger({ component: 'database' });
export const apiLogger = createChildLogger({ component: 'api' });
export const agentLogger = createChildLogger({ component: 'agent' });
export const toolLogger = createChildLogger({ component: 'tool' });
export const channelLogger = createChildLogger({ component: 'channel' });
export const securityLogger = createChildLogger({ component: 'security' });
export const modelLogger = createChildLogger({ component: 'model' });

export type Logger = typeof logger;
