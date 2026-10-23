import { useQuery } from '@tanstack/react-query';
import { MODULES } from '../../src/modules';
import type { ModulesResponse, ModuleView } from '../../src/shared/modules';
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

const under = (pathname: string, page: string) => pathname === page || pathname.startsWith(`${page}/`);

/** The module whose page `pathname` is, when that module is off. */
export function offModuleFor(pathname: string, modules: readonly ModuleView[] | undefined): ModuleView | undefined {
  return modules?.find((m) => !m.on && m.pages.some((page) => under(pathname, page)));
}

/** Is `pathname` a page of some module (from the declarations the build ships with)? */
export function isModulePage(pathname: string): boolean {
  return MODULES.some((m) => m.pages.some((page) => under(pathname, page)));
}

/**
 * Whether a page may be linked to. Until `/api/modules` has answered (or
 * when it fails), a module's page counts as off: it appears once known to be
 * on instead of flashing in and out.
 */
export function usePageOn(): (href: string) => boolean {
  const modules = useModules();
  return (href: string) => {
    const path = href.split('?')[0];
    if (!modules.data) return !isModulePage(path);
    return offModuleFor(path, modules.data.modules) === undefined;
  };
}
