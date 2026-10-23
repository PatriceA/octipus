import type { ModuleProfile } from '@/shared/modules';

/**
 * One module (docs/MODULES.md): everything it brings, declared once in
 * `src/modules/<id>.ts`. When the module is off, each of these is gone:
 * its routes answer 404, its tools are in no agent's tool set, its jobs do
 * not run and its pages leave the sidebar. Its data stays.
 */
export interface ModuleDefinition {
  id: string;
  title: string;
  description: string;
  /** The onboarding use cases that switch it on. */
  profiles: ModuleProfile[];
  /** Modules it needs. */
  dependsOn: string[];
  /** URL path prefixes it serves, as mounted (`/api/cases`, `/a`). */
  routes: string[];
  /** Web pages (sidebar entries). */
  pages: string[];
  /** Tool container ids (`BaseTool.id`). */
  tools: string[];
  /** Background jobs: the names the cron tick and the heartbeat check (`isJobOn`). */
  jobs: string[];
  /** Case link entity types it owns: hidden from case views while it is off. */
  caseEntities: string[];
  /** Its documentation, relative to the repository. */
  docs?: string;
}
