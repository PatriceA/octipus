export { ConnectionManager, type GatewayConnection } from './connection-manager';
export { connectEventBridge } from './event-bridge';
export { GatewayEventBus } from './event-bus';
export { GatewayHub, getGatewayHub } from './hub';
export { ensureLocalToken, regenerateLocalToken, validateLocalAuth } from './local-auth';
export { wireMessageHandler } from './message-handler';
export { type PresenceEntry, type PresenceStats, PresenceTracker } from './presence';
export {
  type ClientMessage,
  type ClientType,
  type ConnectionContext,
  type ConnectionState,
  type GatewayEvent,
  type GatewayMessage,
  matchesPattern,
  PROTOCOL_VERSION,
  parseClientMessage,
  SUPPORTED_VERSIONS,
  type TrustLevel,
} from './protocol';
export { GatewayRateLimiter } from './rate-limiter';
export { attachStdioAdapter, type StdioAdapter, type StdioAdapterOptions, stdioModeRequested } from './stdio-adapter';
