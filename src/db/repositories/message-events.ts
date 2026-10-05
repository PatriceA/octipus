import { EventEmitter } from 'node:events';
import type { Message, NewMessage } from '../schema/messages';
import { dbLogger } from '@/utils/logger';
import { sessionKindOf } from './session-kind';

/**
 * Every message row, announced once it is committed (coworking §6.4).
 *
 * Each insert path of the message repositories (`create`,
 * `createForGeneration`, `createMany`, `ScopedMessageRepo.create`) emits
 * `created` with the row AFTER its statement or transaction committed, so a
 * rolled-back insert ("conversation cleared") never reaches a listener.
 * The room fan-out (`src/core/rooms/fanout.ts`) subscribes; the repositories
 * import no rooms code.
 *
 * Listeners run synchronously in the writer's call; a throwing listener is
 * logged and never fails the write that already committed.
 */
interface MessageEventMap {
  created: [Message];
}

class MessageEvents extends EventEmitter<MessageEventMap> {
  /** Announce committed rows. */
  announce(rows: readonly Message[]): void {
    for (const row of rows) {
      try {
        this.emit('created', row);
      } catch (err) {
        dbLogger.error({ err, messageId: row.id, sessionId: row.sessionId }, 'message created listener failed');
      }
    }
  }
}

export const messageEvents = new MessageEvents();
messageEvents.setMaxListeners(50);

/** Why a room refuses a user row: a post is stored once, by the room, with its author. */
export const ROOM_USER_ROW_REFUSED = 'A room post is stored once, with its author: this writer must not add a user row to a room';

/**
 * Refuse a `role: 'user'` row without `authorUserId` in a room (§6.3:
 * exactly one user row per post, structurally). Throws; returns otherwise.
 */
export async function assertRoomAuthor(rows: readonly Pick<NewMessage, 'sessionId' | 'role' | 'authorUserId'>[]): Promise<void> {
  for (const row of rows) {
    if (row.role !== 'user' || row.authorUserId) continue;
    if ((await sessionKindOf(row.sessionId)) === 'room') throw new Error(ROOM_USER_ROW_REFUSED);
  }
}
