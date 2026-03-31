export { ConnectionManager, type GatewayConnection } from './connection-manager';
export { GatewayEventBus } from './event-bus';
export { GatewayRateLimiter } from './rate-limiter';
export { ensureLocalToken, validateLocalAuth, regenerateLocalToken } from './local-auth';
export {
  type ClientMessage,
  type GatewayMessage,
  type GatewayEvent,
  type ConnectionContext,
  type ConnectionState,
  type TrustLevel,
  type ClientType,
  parseClientMessage,
  matchesPattern,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
} from './protocol';
export { PresenceTracker, type PresenceEntry, type PresenceStats } from './presence';
export { GatewayHub, getGatewayHub } from './hub';
export { connectEventBridge } from './event-bridge';
export { wireMessageHandler } from './message-handler';
