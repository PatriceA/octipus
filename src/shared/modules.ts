/**
 * Modules (docs/MODULES.md): parts of Octipus that ship with it but are not
 * everyone's, switched on install-wide. The shapes the API returns and the
 * web reads. Dependency-free, like the rest of `src/shared`.
 */

/** The onboarding use cases a module is switched on by (src/shared/onboarding/use-cases.ts). */
export type ModuleProfile = 'development' | 'company' | 'product' | 'research';

/** What `GET /api/modules` reports for one module. */
export interface ModuleView {
  id: string;
  title: string;
  description: string;
  /** The use cases that switch it on during onboarding. */
  profiles: ModuleProfile[];
  /** Modules it needs; turning it on turns them on. */
  dependsOn: string[];
  /** Modules that need it: it cannot be turned off while one of them is on. */
  requiredBy: string[];
  /** The web pages it brings (sidebar entries). */
  pages: string[];
  /** What it adds, for Settings → Modules: route prefixes, tools and jobs. */
  routes: string[];
  tools: string[];
  jobs: string[];
  on: boolean;
}

export interface ModulesResponse {
  modules: ModuleView[];
  /** Ids of the modules that are on. */
  enabled: string[];
}
