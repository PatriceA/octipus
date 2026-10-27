import { z } from 'zod';

export const pipelineItemEditSchema = z.object({
  skip: z.array(z.string()).max(200).default([]),
  add: z.array(z.object({ title: z.string().trim().min(1).max(500), detail: z.string().max(20000).optional(),
    acceptance: z.array(z.string().min(1)).max(100).optional(), beforeItemId: z.string().min(1).optional() })).max(100).default([]),
  reopen: z.array(z.string().min(1)).max(200).optional(),
  update: z.array(z.object({ id: z.string().min(1), title: z.string().trim().min(1).max(500).optional(),
    detail: z.string().max(20000).optional(), acceptance: z.array(z.string().min(1)).max(100).optional(),
  }).strict()).max(100).optional(),
  order: z.array(z.string()).max(500).optional(),
  evidence: z.string().trim().min(1).max(4000),
});
export type PipelineItemEdit = z.infer<typeof pipelineItemEditSchema>;

/** An audited answer bound to the item and stage attempt it unblocks. */
export interface PipelineUserDecision {
  itemId: string;
  blockedItemId: string | null;
  nodeKey: string;
  attemptId: string;
  question: string;
  response: string;
  decidedBy: string;
  decidedAt: string;
}
