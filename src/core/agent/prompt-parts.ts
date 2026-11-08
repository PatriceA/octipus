/**
 * Split a role's base prompt for the Context inspector. Kept apart from
 * `prompt-composition.ts` because it needs the role constants, and the worker
 * that imports that module must not pull in the role registry.
 */
import { promptPart, type PromptPart, type PromptTagger } from './prompt-composition';
import { OUTPUT_FORMATTING_RULES, SECURITY_PREAMBLE } from './roles';
import { VAULT_USAGE_GUIDANCE } from './vault-guidance';
import { VOLATILE_MARKER } from '@/models/providers/prompt-cache';

/**
 * The fixed guardrails, whatever a `before-agent-start` hook put after the
 * preamble (the persona), and the role prompt itself. Works off the real
 * constants; a prompt that does not start with them is attributed to the role
 * whole.
 */
export function splitBasePrompt(text: string, roleLabel: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let rest = text;
  if (rest.startsWith(SECURITY_PREAMBLE)) {
    parts.push(promptPart('static', 'guardrails', 'Security preamble', SECURITY_PREAMBLE));
    rest = rest.slice(SECURITY_PREAMBLE.length);
    const formatting = rest.indexOf(OUTPUT_FORMATTING_RULES);
    if (formatting >= 0) {
      if (formatting > 0) parts.push(promptPart('static', 'role', 'Persona', rest.slice(0, formatting)));
      parts.push(promptPart('static', 'guardrails', 'Output formatting', OUTPUT_FORMATTING_RULES));
      rest = rest.slice(formatting + OUTPUT_FORMATTING_RULES.length);
    }
  }
  if (rest.startsWith(VAULT_USAGE_GUIDANCE)) {
    parts.push(promptPart('static', 'guardrails', 'Vault guidance', VAULT_USAGE_GUIDANCE));
    rest = rest.slice(VAULT_USAGE_GUIDANCE.length);
  }
  if (rest) parts.push(promptPart('static', 'role', roleLabel, rest));
  return parts;
}

/**
 * The root prompt's builder blocks (`prompt-builder.ts`) by inspector
 * category. Every label `root-runner.ts` adds is listed; a test fails when
 * one is not, and an unlisted label still shows, as "other".
 */
export const BUILDER_LABELS: Record<string, { category: PromptPart['category']; label: string }> = {
  'role-prompt': { category: 'role', label: 'Role prompt' },
  'delegation-policy': { category: 'delegation', label: 'Delegation policy' },
  'delegation-mechanics': { category: 'delegation', label: 'Delegation guide' },
  'persona': { category: 'role', label: 'Persona' },
  'dev-project': { category: 'workspace', label: 'Dev-mode project' },
  'workspace-suite': { category: 'workspace', label: 'Repo map' },
  'workspace-listing': { category: 'workspace', label: 'Workspace folders' },
  'space-notice': { category: 'workspace', label: 'Shared space notice' },
  'inline-ui': { category: 'guardrails', label: 'Interactive answer rules' },
  'dropped-tool-groups': { category: 'tools', label: 'Tool groups left out this turn' },
  // Each per-turn part, categorised by the runner's tagger.
  'turn-context': { category: 'turn', label: 'Turn context' },
};

export function categorizeBuilderParts(
  blocks: ReadonlyArray<Readonly<{ tier: string; label: string; text: string; drifts?: boolean }>>,
  opts: {
    roleLabel: string;
    notes: Record<string, { status?: 'truncated' | 'capped'; note?: string }>;
    /** The drifting blocks are this conversation's first copy, not today's. */
    replayed: boolean;
    tagger: PromptTagger;
  },
): PromptPart[] {
  return blocks.flatMap((b): PromptPart[] => {
    const tier = b.tier === 'turn' ? 'volatile' : 'static';
    if (b.label === 'role-prompt') return splitBasePrompt(b.text, opts.roleLabel);
    if (b.label === 'turn-context') return opts.tagger.resolve([], [b.text]);
    const known = BUILDER_LABELS[b.label];
    if (!known) return [promptPart(tier, 'other', b.label, b.text)];
    const note = b.drifts && opts.replayed
      ? { note: 'as first seen in this conversation (replayed so the cached prefix holds)' }
      : opts.notes[b.label] ?? {};
    return [promptPart(tier, known.category, known.label, b.text, note)];
  });
}

/**
 * A worker's, swarm child's or pipeline stage's system prompt by category,
 * as the agent manager has it at spawn: the role's base prompt split as for
 * the root, the per-run tail (date, profile, memories, git status…) after the
 * cache split, then what the manager appends.
 */
export function agentPromptParts(systemPrompt: string, role: string, appended: { mcpSection?: string; selectedSkills?: string } = {}): PromptPart[] {
  const at = systemPrompt.match(VOLATILE_MARKER)?.index;
  const stable = at === undefined ? systemPrompt : systemPrompt.slice(0, at);
  const tail = at === undefined ? '' : systemPrompt.slice(at);
  return [
    ...(stable ? splitBasePrompt(stable, `${role} role prompt`) : []),
    ...(tail ? [promptPart('volatile', 'turn', 'Per-run context (date, profile, memories, workspace)', tail)] : []),
    ...(appended.mcpSection ? [promptPart('static', 'tools', 'MCP servers', `\n\n${appended.mcpSection}`)] : []),
    ...(appended.selectedSkills ? [promptPart('static', 'skills', 'Selected skills', appended.selectedSkills)] : []),
  ];
}
