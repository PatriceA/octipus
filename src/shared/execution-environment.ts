import { z } from 'zod';

const directory = z.string().min(1).refine(value => /^(\/|[A-Za-z]:[\\/])/.test(value) && !/[\x00-\x1f]/.test(value), 'Choose an absolute directory');

/** Owner configuration, never model-provided execution options. */
export const executionEnvironmentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  revision: z.number().int().min(0).default(0),
  name: z.string().trim().min(1).max(120),
  userId: z.uuid(),
  workspaceId: z.uuid().nullable().default(null),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  backend: z.enum(['host', 'sandbox', 'ssh']),
  installedPrograms: z.enum(['approved', 'all']).default('approved'),
  pathDirectories: z.array(directory).max(50).default([]),
  authority: z.enum(['tools', 'account']).default('tools'),
  pipelineAutonomy: z.boolean().default(false),
  roots: z.array(directory).min(1).max(50),
  credentials: z.array(z.object({ variable: z.string().regex(/^[A-Z][A-Z0-9_]*$/).refine(name => !/^(?:HOME|USERPROFILE|PATH|SHELL|ENV|BASH_ENV|NODE_OPTIONS|PYTHONPATH|LD_.*|DYLD_.*|GIT_CONFIG.*|SSH_AUTH_SOCK|OCTIPUS_.*|CODEX_HOME|CLAUDE_CONFIG_DIR|MASTER_KEY|JWT_SECRET|SESSION_SECRET|DATABASE_URL)$/.test(name), 'Choose a credential variable, not a runtime control variable'), secret: z.string().min(1).max(200) }).strict()).max(50).default([]),
  network: z.boolean().default(false),
  hostIdentity: z.boolean().default(false),
  hostServices: z.boolean().default(false),
  approval: z.enum(['ask', 'automatic']).default('ask'),
  background: z.enum(['ask', 'automatic', 'deny']).default('ask'),
  allowDataTransfer: z.boolean().default(false),
  ssh: z.object({
    host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/),
    user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/),
    port: z.number().int().min(1).max(65535).default(22),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.credentials.map(binding => binding.variable)).size !== value.credentials.length) ctx.addIssue({ code: 'custom', message: 'Credential variable names must be unique', path: ['credentials'] });
  if (value.backend === 'ssh' && value.roots.some(root => !root.startsWith('/'))) ctx.addIssue({ code: 'custom', message: 'SSH execution requires absolute POSIX paths on a Linux/macOS host', path: ['roots'] });
  if (value.backend === 'ssh' && !value.ssh) ctx.addIssue({ code: 'custom', message: 'Remote execution needs an SSH host and account', path: ['ssh'] });
  if (value.authority === 'account' && (value.backend === 'sandbox' || value.backend === 'host' && !value.hostIdentity)) ctx.addIssue({ code: 'custom', message: 'Account authority requires trusted host identity or a remote account', path: ['authority'] });
  if (value.pipelineAutonomy && (value.authority !== 'account' || value.background !== 'automatic')) ctx.addIssue({ code: 'custom', message: 'Pipeline autonomy requires account authority and automatic background work', path: ['pipelineAutonomy'] });
  if (value.backend !== 'host' && value.hostIdentity) ctx.addIssue({ code: 'custom', message: 'Only a trusted host environment can use the host account identity', path: ['hostIdentity'] });
  if (value.backend === 'ssh' && value.hostServices) ctx.addIssue({ code: 'custom', message: 'Remote services belong to the remote account, not hostServices', path: ['hostServices'] });
});
export type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;

export const executionEnvironmentsSchema = z.array(executionEnvironmentSchema).max(200).superRefine((entries, ctx) => {
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) ctx.addIssue({ code: 'custom', message: 'Environment IDs must be unique' });
  const defaults = entries.filter(entry => entry.enabled && entry.isDefault).map(entry => `${entry.userId}:${entry.workspaceId ?? '*'}`);
  if (new Set(defaults).size !== defaults.length) ctx.addIssue({ code: 'custom', message: 'Choose one default environment per account/workspace' });
});

export const environmentInventorySchema = z.object({
  commands: z.array(z.object({ name: z.string().max(4096), path: z.string().max(32768) }).strict()).max(4096),
  sshAliases: z.array(z.string().max(255)).max(4096), truncated: z.boolean(),
}).strict();
export type EnvironmentInventory = z.infer<typeof environmentInventorySchema>;

export type EnvironmentReadiness = { inventory?: EnvironmentInventory; result?: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }; status: 'ready' | 'not_installed' | 'not_connected' | 'not_authorized' | 'unreachable' | 'check_failed'; summary: string; checks: Array<{ name: string; passed: boolean; detail: string }> };

/** One owner-reviewed preset; installed commands and SSH access are not enumerated. */
export function workstationAutomationPreset(userId: string, id: string, roots: string[]): ExecutionEnvironment {
  const preset = executionEnvironmentSchema.parse({ id, userId, name: 'Workstation automation', backend: 'host',
    authority: 'account', pipelineAutonomy: true, installedPrograms: 'all', roots: roots.length ? roots : ['/'], hostIdentity: true, hostServices: true,
    network: true, allowDataTransfer: true, approval: 'automatic', background: 'automatic',
  });
  return { ...preset, roots }; // Empty roots are an unsaved UI draft, never a runtime grant.
}
