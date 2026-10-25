import { z } from 'zod';

/** Requested by the model/API, activated only by a human approval of this run. */
export const pipelinePermissionProfileSchema = z.object({
  repoPath: z.string().min(1),
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
