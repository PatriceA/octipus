import type { ToolHandler } from '@/core/agent-base';
import { measureRootRequest, type MeasuredComposition, type StagedRootPrompt } from './prompt-composition';

/** Known Octipus payload, never a claim about hidden vendor instructions or retained history. */
export function measureCliPayload(input: {
  staged?: StagedRootPrompt;
  system: string;
  prompt: string;
  tools: ToolHandler[];
  role: string;
  model: string;
  resumed: boolean;
}): MeasuredComposition {
  const parts = input.staged?.parts ?? [];
  // Preserve known skill/role attribution; account for adapter additions separately.
  const remaining = parts.reduce((text, p) => text.replace(p.text, ''), input.system).trim();
  const present = parts.filter((p) => input.system.includes(p.text));
  const result = measureRootRequest({
    staged: {
      ...input.staged,
      role: input.role,
      model: input.model,
      parts: [
        ...present,
        ...(remaining
          ? [{ category: 'other' as const, tier: 'static' as const, label: 'CLI instructions', text: remaining }]
          : []),
      ],
    },
    tools: input.tools,
    history: [],
    userText: input.prompt,
    userLabel: input.resumed ? 'New input to resumed CLI' : 'Conversation replay and request',
  });
  return { ...result, source: 'cli-payload', resumed: input.resumed };
}
