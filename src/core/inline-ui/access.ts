/**
 * Who may read an interactive answer: whoever may read the conversation it is
 * in (spec S8). A chat — personal, a member's private space chat, a group
 * thread's web view — goes through the scoped session read every chat route
 * uses (`contentRepos`, which also covers admins and impersonation); a room
 * goes through `roomAccess` (any member, guests within their scope, members
 * of another install).
 */
import type { Principal } from '@/security/principal';
import { contentRepos } from '@/db/repositories/content';
import { roomAccess } from '@/core/rooms/access';

export interface InlineUiReader {
  sessionId: string;
  /** Read by more people than the one who asked (a room): scripts wait for a click. */
  shared: boolean;
}

export async function inlineUiReader(principal: Principal, sessionId: string): Promise<InlineUiReader | null> {
  const session = await contentRepos(principal).sessions.findById(sessionId);
  if (session) return { sessionId, shared: !!session.groupChannelId };
  const room = await roomAccess(principal.userId, sessionId);
  return room ? { sessionId, shared: true } : null;
}
