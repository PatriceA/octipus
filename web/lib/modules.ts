import { useQuery } from '@tanstack/react-query';
import type { ModulesResponse } from '../../src/shared/modules';
import { api } from './api';

export type { ModuleView, ModulesResponse } from '../../src/shared/modules';

export const modulesKey = ['modules'] as const;

/** What is on (docs/MODULES.md): the sidebar and Settings → Modules read it. */
export function useModules(enabled = true) {
  return useQuery({
    queryKey: modulesKey,
    queryFn: () => api.get<ModulesResponse>('/modules'),
    enabled,
    staleTime: 60_000,
  });
}
