import { z } from 'zod';
/** Operator-owned binding, separate from ordinary project sandboxes. No secrets. */
export const companionMaintenanceSchema = z.object({
  enabled: z.boolean().default(false),
  userId: z.uuid().nullable().default(null),
  roots: z.array(z.string().startsWith('/').max(2000)).max(30).default([]),
  hostServices: z.boolean().default(false),
  sshAgent: z.boolean().default(false),
  /** Controls the managed launcher; arbitrary approved maintenance scripts retain server-account powers. */
  allowActivation: z.boolean().default(false),
  interruptionPolicy: z.enum(['wait', 'interrupt']).default('wait'),
}).strict().refine(v => !v.enabled || !!v.userId && v.roots.length > 0, 'Choose an owner and at least one maintenance directory');
export type CompanionMaintenance = z.infer<typeof companionMaintenanceSchema>;
