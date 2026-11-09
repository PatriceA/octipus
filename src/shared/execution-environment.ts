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
  roots: z.array(directory).min(1).max(50),
  credentials: z.array(z.object({ variable: z.string().regex(/^[A-Z][A-Z0-9_]*$/).refine(name => !/^(?:HOME|USERPROFILE|PATH|SHELL|ENV|BASH_ENV|NODE_OPTIONS|PYTHONPATH|LD_.*|DYLD_.*|GIT_CONFIG.*|SSH_AUTH_SOCK|MASTER_KEY|JWT_SECRET|SESSION_SECRET|DATABASE_URL)$/.test(name), 'Choose a credential variable, not a runtime control variable'), secret: z.string().min(1).max(200) }).strict()).max(50).default([]),
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
  if (value.backend !== 'host' && value.hostIdentity) ctx.addIssue({ code: 'custom', message: 'Only a trusted host environment can use the host account identity', path: ['hostIdentity'] });
  if (value.backend === 'ssh' && value.hostServices) ctx.addIssue({ code: 'custom', message: 'Remote services belong to the remote account, not hostServices', path: ['hostServices'] });
});
export type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;

export const executionEnvironmentsSchema = z.array(executionEnvironmentSchema).max(200).superRefine((entries, ctx) => {
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) ctx.addIssue({ code: 'custom', message: 'Environment IDs must be unique' });
  const defaults = entries.filter(entry => entry.enabled && entry.isDefault).map(entry => `${entry.userId}:${entry.workspaceId ?? '*'}`);
  if (new Set(defaults).size !== defaults.length) ctx.addIssue({ code: 'custom', message: 'Choose one default environment per account/workspace' });
});

export type EnvironmentReadiness = { result?: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }; status: 'ready' | 'not_installed' | 'not_connected' | 'not_authorized' | 'unreachable' | 'check_failed'; summary: string; checks: Array<{ name: string; passed: boolean; detail: string }> };
