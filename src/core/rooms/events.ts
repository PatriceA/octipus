/**
 * Delivery of room and space events (docs/plans/coworking-spec.md §6.6).
 *
 * Room events go to the resource `room:<id>` through
 * `GatewayHub.publishToResource` — outside the event bus and outside the
 * user rule: a connection is in that resource only after its `room.subscribe`
 * passed `roomAccess`, and `onRoomAccessChanged` / `onMembershipChanged`
 * prune it. Every other event keeps going to its own user only.
 *
 * Room events are not kept for replay: a reconnecting client catches up
 * from the messages table (`room.subscribe` with `afterMessageId`).
 */
import { randomBytes } from 'node:crypto';
import { getGatewayHub } from '@/core/gateway/hub';
import type { GatewayMessage, GlobalEventType } from '@/core/gateway/protocol';

export type RoomEventType = Extract<GlobalEventType, `room.${string}`>;

export const roomResource = (roomId: string): string => `room:${roomId}`;
export const spaceResource = (spaceId: string): string => `space:${spaceId}`;

/** The gateway message of one room or space event. */
export function eventMessage(type: GlobalEventType, payload: unknown, sessionId?: string): GatewayMessage {
  return {
    type: 'event',
    event: {
      id: randomBytes(12).toString('hex'),
      type,
      source: 'rooms',
      ...(sessionId ? { sessionId } : {}),
      timestamp: Date.now(),
      payload,
    },
  };
}

/** Send `type` to every connection subscribed to the room. */
export function publishRoomEvent(roomId: string, type: RoomEventType, payload: unknown): void {
  getGatewayHub().publishToResource(roomResource(roomId), eventMessage(type, payload, roomId));
}
