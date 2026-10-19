import { z } from 'zod';

export const pipelineItemEditSchema = z.object({
  skip: z.array(z.string()).max(200).default([]),
  add: z.array(z.object({ title: z.string().trim().min(1).max(500), detail: z.string().max(20000).optional(),
    acceptance: z.array(z.string().min(1)).max(100).optional() })).max(100).default([]),
  order: z.array(z.string()).max(500).optional(),
  evidence: z.string().trim().min(1).max(4000),
});
export type PipelineItemEdit = z.infer<typeof pipelineItemEditSchema>;
