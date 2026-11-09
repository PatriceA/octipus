import { z } from 'zod';
/** A run finishing never certifies project completion. */
export const deskStateSchema = z.enum(['working', 'needs_you', 'blocked', 'paused', 'updated', 'idle', 'unknown']);
export type DeskState = z.infer<typeof deskStateSchema>;
export const DESK_STATE_LABEL: Record<DeskState, string> = {
  working: 'Working', needs_you: 'Needs you', blocked: 'Needs investigation', paused: 'Paused',
  updated: 'Updated', idle: 'No active run', unknown: 'Status unconfirmed',
};
export const deskSessionSchema = z.object({
  id: z.string(), title: z.string(), state: deskStateSchema, activity: z.string(),
  outcome: z.string().nullable(), next: z.string().nullable(), updatedAt: z.string(),
  plan: z.object({ title: z.string(), revision: z.number(), updatedAt: z.string(),
    changes: z.array(z.object({ at: z.string(), summary: z.string() })) }).nullable(),
  events: z.array(z.object({ at: z.string(), text: z.string() })), pipelineId: z.string().nullable(),
});
export const workspaceDeskSchema = z.object({ observedAt: z.string(), sessions: z.array(deskSessionSchema), total: z.number(), warnings: z.array(z.string()) });
export type DeskSession = z.infer<typeof deskSessionSchema>;
export type WorkspaceDesk = z.infer<typeof workspaceDeskSchema>;
