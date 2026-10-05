/**
 * Commands posted in a room (docs/plans/coworking-spec.md §6.2).
 *
 * A post starting with `/` is a command, not a post: it is not stored, the
 * answer goes to the poster only, and the rules are the room column of the
 * `canActInSession` table:
 *
 *   /help, /status, /cancel  any member (status without other members' details)
 *   /stop                    the running turn's requester, or an editor+;
 *                            `/stop queue` (editor+) also clears the queue
 *   /clear, /compact         the room's creator or a space owner
 *   /model, /voice, /learn…  refused (model choice and learning are the
 *                            requester's own, personal — not a room's)
 */
import { canActInSession } from './access';
import { cancelQueuedTurn, clearRoomQueue, roomQueueSnapshot, runningRequester, stopRoomTurn } from './queue';

const HELP = [
  'Room commands:',
  '  /status        what Octipus is doing in this room',
  '  /stop          stop the running answer (yours; editors and owners: anyone\'s)',
  '  /stop queue    stop it and clear the queue (editors and owners)',
  '  /cancel        cancel your requests still waiting',
  '  /clear         start the room\'s conversation with Octipus afresh (room creator, space owner)',
  '  /compact       summarize the room\'s older messages for Octipus (room creator, space owner)',
  'Ask Octipus with the "Ask Octipus" toggle or by writing @octipus.',
].join('\n');

const REFUSED: Record<string, string> = {
  model: 'Model choice is per member, not per room: pick your model in your settings.',
  voice: 'Voice mode is not available in a room.',
  learn: 'Learning is personal and not available in a room.',
  skills: 'Skill choices are per member, not per room.',
};

/** Answer the command `content` (starting with `/`) of `userId` in the room. */
export async function runRoomCommand(roomId: string, userId: string, content: string): Promise<string> {
  const [head, ...rest] = content.trim().split(/\s+/);
  const name = head.slice(1).toLowerCase();
  const arg = rest.join(' ').trim().toLowerCase();
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const room = await sessionRepository.findById(roomId);
  if (!room || room.kind !== 'room' || !(await canActInSession(room, userId, 'control'))) return 'Room not found.';

  switch (name) {
    case 'help':
      return HELP;
    case 'status': {
      const snapshot = roomQueueSnapshot(roomId);
      const mine = snapshot.queued.filter((q) => q.requesterId === userId).length;
      const lines = [
        snapshot.running
          ? `Octipus is ${snapshot.running.waiting ? `waiting for ${snapshot.running.requesterName} to approve` : `answering ${snapshot.running.requesterName}`} (since ${snapshot.running.startedAt}).`
          : 'Octipus is idle in this room.',
        `${snapshot.queued.length} request(s) waiting${mine > 0 ? `, ${mine} of them yours` : ''}.`,
      ];
      return lines.join('\n');
    }
    case 'cancel': {
      const mine = roomQueueSnapshot(roomId).queued.filter((q) => q.requesterId === userId);
      let cancelled = 0;
      for (const q of mine) if (cancelQueuedTurn(roomId, q.messageId, userId, false)) cancelled++;
      return cancelled > 0 ? `Cancelled ${cancelled} waiting request(s).` : 'You have no request waiting.';
    }
    case 'stop': {
      const requester = runningRequester(roomId);
      const clearQueue = arg === 'queue' || arg === 'all';
      if (clearQueue) {
        // Clearing everyone's queue is an editor+ act, whoever runs now.
        if (!(await canActInSession(room, userId, 'stop', { turnRequesterId: null }))) return 'Only editors and owners can clear the room\'s queue.';
      } else if (!requester) {
        return 'Nothing is running in this room.';
      } else if (!(await canActInSession(room, userId, 'stop', { turnRequesterId: requester }))) {
        return 'Only the member Octipus is answering, or an editor or owner, can stop it.';
      }
      const stopped = await stopRoomTurn(roomId);
      const cleared = clearQueue ? clearRoomQueue(roomId) : 0;
      return [stopped ? 'Stopped.' : 'Nothing was running.', clearQueue ? `Cleared ${cleared} waiting request(s).` : ''].filter(Boolean).join(' ');
    }
    case 'clear': {
      if (!(await canActInSession(room, userId, 'manage'))) return 'Only the room\'s creator or a space owner can clear it.';
      if (runningRequester(roomId)) return 'Octipus is answering right now; /stop first, then /clear.';
      await sessionRepository.clearContext(roomId);
      return 'Octipus starts this room\'s conversation afresh. The messages stay for everyone to read.';
    }
    case 'compact': {
      if (!(await canActInSession(room, userId, 'manage'))) return 'Only the room\'s creator or a space owner can compact it.';
      const { maybeCompactSession } = await import('@/core/agent/session-compaction');
      const done = await maybeCompactSession(roomId, { force: true, requesterId: userId, userInstructions: rest.join(' ').trim() || undefined });
      return done ? 'Older messages summarized for Octipus; recent ones kept as they are.' : 'Nothing to summarize yet.';
    }
    default:
      return REFUSED[name] ?? `/${name} is not available in a room. Type /help for the room's commands.`;
  }
}
