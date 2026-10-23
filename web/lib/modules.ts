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

/** The module whose page `pathname` is, when that module is off. */
export function offModuleFor(pathname: string, modules: readonly import('../../src/shared/modules').ModuleView[] | undefined) {
  return modules?.find((m) => !m.on && m.pages.some((page) => pathname === page || pathname.startsWith(`${page}/`)));
}

/** Whether a page may be linked to: false for a page of a module that is off. */
export function usePageOn(): (href: string) => boolean {
  const modules = useModules();
  return (href: string) => offModuleFor(href.split('?')[0], modules.data?.modules) === undefined;
}
