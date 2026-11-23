/**
 * The personal to-do list is live: every write through the personal task door
 * (TaskRepo in the personal scope — the routes, the tasks tool, `/todo`, a
 * repeat's next occurrence) publishes `tasks.changed { taskId }` to the
 * owner's own connections, so the web list and the mobile app refetch at once
 * instead of polling (a space's board hears `task.changed` the same way,
 * core/tasks/team.ts). Ids only: the client reads the task through the API.
 *
 * The write is the operation; the event only tells. A publish that fails is
 * logged, never thrown — a client that missed it catches up on its next read.
 */
import { coreLogger } from '@/utils/logger';

export function publishPersonalTaskChanged(userId: string, taskId: string): void {
  import('@/core/gateway/hub')
    .then(({ getGatewayHub }) => {
      getGatewayHub().publishEvent({ type: 'tasks.changed', source: 'tasks', userId, payload: { taskId } });
    })
    .catch((err: unknown) => coreLogger.error({ err, userId, taskId }, 'tasks.changed not published'));
}
