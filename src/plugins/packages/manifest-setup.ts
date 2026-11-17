import { z } from 'zod';
import { PLUGIN_RESOURCE_KINDS } from '@/shared/plugin-setup';

export const setupSchema = z.object({
  defaults: z.record(z.string(), z.union([z.string().max(20000), z.number(), z.boolean()])).optional(),
  resources: z.array(z.object({
    setting: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    kind: z.enum(PLUGIN_RESOURCE_KINDS),
    multiple: z.boolean().optional(),
    connectionKind: z.enum(['http', 'git']).optional(),
    presets: z.array(z.object({ label: z.string().min(1).max(100), paths: z.array(z.string().min(1).max(2000).regex(/^\/(?!\/)[^\\\r\n\0#]*$/)).min(1).max(100) }).strict()).min(1).max(10).optional(),
  }).strict()).max(50).optional(),
  check: z.object({
    tool: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    input: z.record(z.string(), z.unknown()).refine(v => JSON.stringify(v).length <= 4000, 'setup.check.input is too large').optional(),
  }).strict().optional(),
}).strict();
