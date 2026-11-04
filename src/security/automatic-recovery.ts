import type { AgentContext } from '@/core/types';
import { userRepository } from '@/db/repositories/user-repository';
import { isUuid } from '@/db/repositories/scoped';

/** An account's explicit preference applies to its personal runs only. */
export async function automaticRecoveryAllowed(context: Pick<AgentContext, 'userId' | 'space' | 'trigger'> & { audienceFederated?: boolean }): Promise<boolean> {
  if (!isUuid(context.userId) || context.space || context.trigger === 'remote' || context.audienceFederated) return false;
  const user = await userRepository.findById(context.userId);
  return user?.isActive === true && user.kind === 'local' && user.preferences?.autoApproveRecovery === true;
}
