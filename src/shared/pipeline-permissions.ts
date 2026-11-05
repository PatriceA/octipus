import { z } from 'zod';

/** Requested by the model/API, activated only by a human approval of this run. */
export const pipelinePermissionProfileSchema = z.object({
  executionScope: z.enum(['commands', 'run']).default('commands').describe('run: authorize shell work for this pipeline across approved repositories, including scripts, remote deployment, destructive commands and network/credential use. No command list is required. Existing DENY rules and filesystem restrictions still apply. commands: legacy exact-command/family approval.'),
  repoPath: z.string().min(1),
  repoPaths: z.array(z.string().min(1)).max(30).default([]).describe('Additional explicitly approved repositories. Workspace filesystem restrictions still apply.'),
  allowTimedOutCommands: z.boolean().default(false).describe('Allow further work after a shell command covered by this profile returns its own timeout result. Partial effects may remain; inspect before retrying.'),
  commands: z.array(z.string().min(1)).max(100).default([]).describe('Legacy commands scope only; not needed for executionScope=run.'),
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

/** New proposals ask for one run approval; reading an old stored profile must
 * never silently turn a narrow command approval into a broad run approval. */
export const proposedPipelinePermissionProfileSchema = pipelinePermissionProfileSchema.extend({
  executionScope: pipelinePermissionProfileSchema.shape.executionScope.default('run'),
});

export function permissionProfileDisclosure(profile: PipelinePermissionProfile): string {
  return profile.executionScope === 'run'
    ? 'Approve shell work for this pipeline in the selected repositories and their subdirectories, across stages, retries and resumes. This includes new commands, scripts, remote deployment, cleanup, privileged commands when policy permits, and network use of credentials and private data, including data read later in the run. This is not a network destination allowlist. No per-command approval is needed within this scope. Existing DENY rules, filesystem boundaries and shared-workspace restrictions still apply. Approval ends when the pipeline ends or the profile is replaced.'
    : 'Approve the listed commands and command families for this pipeline. New operations outside this legacy scope still require approval; overnight mode denies and records them.';
}
