import { z } from 'zod';

/** Requested by the model/API, activated only by a human approval of this run. */
export const pipelinePermissionProfileSchema = z.object({
  repoPath: z.string().min(1),
  repoPaths: z.array(z.string().min(1)).max(30).default([]).describe('Additional explicitly approved repositories. Workspace filesystem restrictions still apply.'),
  allowTimedOutCommands: z.boolean().default(false).describe('Allow further work after a shell command covered by this profile returns its own timeout result. Partial effects may remain; inspect before retrying.'),
  commands: z.array(z.string().min(1)).max(100).default([]),
  publicHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/i)).max(30).default([]),
  packageManagers: z.array(z.enum(['npm', 'pnpm', 'yarn', 'go'])).default([]),
  dockerProjects: z.array(z.string().regex(/^[a-z0-9_-]+$/i)).default([]),
  hostServices: z.boolean().default(false).describe('Expose host localhost services and the Docker socket to stage shells; command permissions still apply.'),
  rememberDecisions: z.boolean().default(true),
  overnight: z.boolean().default(false),
  autoApproveGates: z.boolean().default(true),
  allowCheckpointReplay: z.boolean().default(false).describe('Permit repeating completed stage effects when resuming a checkpoint. Uncertain outcomes still require inspection.'),
}).strict();
export type PipelinePermissionProfile = z.infer<typeof pipelinePermissionProfileSchema>;
