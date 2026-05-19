import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { ringBufferStream } from './log-stream';

const logLevel = process.env.LOG_LEVEL || 'info';
const logFormat = process.env.LOG_FORMAT || 'pretty';

const stdoutStream =
  logFormat === 'pretty'
    ? (pinoPretty({
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      }) as unknown as NodeJS.WritableStream)
    : process.stdout;

// Multistream: stdout (pretty or raw) + in-process ring buffer for the
// live log dashboard. Both receive newline-delimited JSON from pino;
// pino-pretty transforms its copy before printing.
const streams = pino.multistream([
  { stream: stdoutStream },
  { stream: ringBufferStream },
]);

export const logger = pino(
  {
    level: logLevel,
    base: { service: 'octipus' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  streams,
);

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
