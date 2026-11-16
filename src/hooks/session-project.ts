import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { sessionRepository } from '@/db/repositories/session-repository';
import { executionEnvironmentFor } from '@/security/execution-environments';
import { environmentCwd } from '@/security/environment-runtime';
import { switchSessionEnvironment, withEnvironmentSessionLock } from '@/security/environment-session';
import { canActInSession } from '@/core/rooms/access';
import { resolveAgentScope } from '@/core/agent/context';

/** An owner-configured folder, never interpolated from an external event. */
export async function configureHookProject(sessionId: string, userId: string, requested: unknown): Promise<void> {
  if (typeof requested !== 'string' || !requested.trim() || !isAbsolute(requested)) {
    throw new Error('Hook project folder must be an absolute path.');
  }
  await withEnvironmentSessionLock(sessionId, async () => {
    const session = await sessionRepository.findById(sessionId);
    if (!session || session.kind === 'room' || !(await canActInSession(session, userId, 'settings'))) throw new Error('Hook project requires an owned personal session.');
    const scope = await resolveAgentScope({ session, userId, trigger: 'schedule' });
    const previous = session.context;
    const profile = executionEnvironmentFor({ userId, ...scope, metadata: {
      executionEnvironmentId: previous?.executionEnvironmentId, projectPath: requested,
    } });
    if (!profile) throw new Error('Select an execution environment before configuring a hook project folder.');
    const projectPath = profile.backend === 'ssh' ? requested : realpathSync(requested);
    environmentCwd(profile, projectPath, profile.authority === 'account');
    if (profile.backend !== 'ssh' && !statSync(projectPath).isDirectory()) throw new Error('Hook project folder must be an existing directory.');
    if (previous?.projectPath === projectPath && previous.executionEnvironmentId === profile.id) return;
    const updated = await switchSessionEnvironment(userId, sessionId, previous, {
      executionEnvironmentId: profile.id, projectPath, devMode: true,
      projectName: projectPath.split(/[/\\]/).pop() || 'project',
      staticPrompt: null,
    });
    if (!updated) throw new Error('Hook project changed or its session is running; retry when the current turn finishes.');
  });
}
