'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';

export type CompanionChatSettings = {
  supervisorSessionId: string | null;
  modelName: string;
  enabled: boolean;
};

/** The saved controller identity, never inferred from a title or a pin. */
export function useCompanionChat() {
  const { activeWorkspace } = useWorkspace();
  return useQuery({
    queryKey: ['companion-settings', activeWorkspace?.id],
    queryFn: () => api.get<CompanionChatSettings>('/companion/settings'),
    enabled: activeWorkspace?.kind === 'personal',
  });
}
