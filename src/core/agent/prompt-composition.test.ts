/**
 * The Context inspector's measurement: every part of a root request lands in
 * a fixed category, nothing is dropped, and the staged hand-off from root
 * runner to worker happens once per spawned agent.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'vitest';
import type { AgentMessage } from '@/core/types';
import { PROMPT_CATEGORIES, tokensByCategory } from '@/shared/prompt-composition';
import {
  _resetPromptCompositionForTesting,
  bindStagedRootPrompt,
  getLatestComposition,
  measureRootRequest,
  PromptTagger,
  promptPart,
  recordLatestComposition,
  stageRootPrompt,
  takeStagedRootPrompt,
  turnContextParts,
  withoutText,
} from './prompt-composition';
import { BUILDER_LABELS, categorizeBuilderParts, splitBasePrompt } from './prompt-parts';
import { OUTPUT_FORMATTING_RULES, SECURITY_PREAMBLE } from './roles';
import { VAULT_USAGE_GUIDANCE } from './vault-guidance';

beforeEach(() => _resetPromptCompositionForTesting());

const msg = (role: AgentMessage['role'], content: string, extra: Partial<AgentMessage> = {}): AgentMessage =>
  ({ role, content, timestamp: new Date(0), ...extra });

describe('splitBasePrompt', () => {
  test('separates the guardrails, the persona a hook inserted and the role prompt, losing nothing', () => {
    const base = `${SECURITY_PREAMBLE}PERSONA: warm and brief.\n${OUTPUT_FORMATTING_RULES}${VAULT_USAGE_GUIDANCE}You are Octipus.`;
    const parts = splitBasePrompt(base, 'general role prompt');
    expect(parts.map((p) => [p.category, p.label])).toEqual([
      ['guardrails', 'Security preamble'],
      ['role', 'Persona'],
      ['guardrails', 'Output formatting'],
      ['guardrails', 'Vault guidance'],
      ['role', 'general role prompt'],
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(base);
  });

  test('a prompt without the preamble is the role prompt whole', () => {
    expect(splitBasePrompt('Custom prompt', 'x')).toEqual([promptPart('static', 'role', 'x', 'Custom prompt')]);
  });
});

describe('PromptTagger', () => {
  test('an untagged block comes back as "other", labelled by its first line, instead of disappearing', () => {
    const tagger = new PromptTagger();
    const tagged = tagger.tag('static', 'delegation', 'Delegation policy', '\n\nDelegate wisely.');
    const parts = tagger.resolve([tagged, '\n\nNEW BLOCK nobody tagged\nmore'], ['\n\nCURRENT DATE & TIME: now']);
    expect(parts.map((p) => [p.tier, p.category, p.label])).toEqual([
      ['static', 'delegation', 'Delegation policy'],
      ['static', 'other', 'NEW BLOCK nobody tagged'],
      ['volatile', 'other', 'CURRENT DATE & TIME: now'],
    ]);
  });

  test('a split is used only when its pieces add up to the pushed text', () => {
    const tagger = new PromptTagger();
    tagger.tagSplit('abc', [promptPart('static', 'role', 'a', 'a'), promptPart('static', 'role', 'b', 'b')]);
    expect(tagger.resolve(['abc'], [])[0].category).toBe('other');
  });

  test('every PromptBuilder block the root runner adds has a category', () => {
    const source = readFileSync(new URL('./root-runner.ts', import.meta.url), 'utf8');
    const labels = [...source.matchAll(/\.add\(\s*(?:'[a-z]+'|[a-zA-Z]+),\s*'([a-z-]+)'/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(8);
    expect(labels.filter((l) => !(l in BUILDER_LABELS))).toEqual([]);
  });

  test('builder blocks: the role prompt is split, a replayed drifting block says so, an unknown label is "other"', () => {
    const tagger = new PromptTagger();
    const date = tagger.tag('volatile', 'turn', 'Current date & time', 'CURRENT DATE & TIME: now');
    const parts = categorizeBuilderParts([
      { tier: 'user', label: 'role-prompt', text: `${SECURITY_PREAMBLE}You are Octipus.` },
      { tier: 'session', label: 'workspace-suite', text: 'WORKSPACE SUITE', drifts: true },
      { tier: 'session', label: 'space-notice', text: 'SHARED SPACE' },
      { tier: 'session', label: 'brand-new-block', text: 'NEW' },
      { tier: 'turn', label: 'turn-context', text: date },
    ], { roleLabel: 'general role prompt', notes: { 'workspace-suite': { status: 'capped', note: '40 of 52 repos' } }, replayed: true, tagger });
    expect(parts.map((p) => [p.tier, p.category, p.label, p.note])).toEqual([
      ['static', 'guardrails', 'Security preamble', undefined],
      ['static', 'role', 'general role prompt', undefined],
      ['static', 'workspace', 'Repo map', 'as first seen in this conversation (replayed so the cached prefix holds)'],
      ['static', 'workspace', 'Shared space notice', undefined],
      ['static', 'other', 'brand-new-block', undefined],
      ['volatile', 'turn', 'Current date & time', undefined],
    ]);
    // Not replayed: the cap note of a fresh block stands.
    expect(categorizeBuilderParts([{ tier: 'session', label: 'workspace-suite', text: 'W', drifts: true }],
      { roleLabel: 'r', notes: { 'workspace-suite': { status: 'capped', note: '40 of 52 repos' } }, replayed: false, tagger })[0])
      .toMatchObject({ status: 'capped', note: '40 of 52 repos' });
  });

  test('every block the root runner pushes is tagged at its push site', () => {
    // The fallback above keeps an untagged block visible; this keeps it from
    // being needed. A push that bypasses the tagger shows up as "other".
    const source = readFileSync(new URL('./root-runner.ts', import.meta.url), 'utf8');
    const pushes = [...source.matchAll(/\b(staticParts|volatileParts)\.push\(\s*([^\n]*)/g)];
    expect(pushes.length).toBeGreaterThanOrEqual(5);
    expect(pushes.filter((m) => !m[2].startsWith('tagger.tag(')).map((m) => m[0])).toEqual([]);
  });
});

describe('turnContextParts', () => {
  test('labelled pieces that add up to the block are kept apart; empty ones are left out', () => {
    const parts = turnContextParts('MEMHOOK', [{ label: 'Long-term memory', text: 'MEM' }, { label: 'Space', text: '' }, { label: 'Hook', text: 'HOOK' }]);
    expect(parts.map((p) => p.label)).toEqual(['Long-term memory', 'Hook']);
  });

  test('pieces that do not add up leave the block whole rather than mis-attributed', () => {
    expect(turnContextParts('MEMHOOK+', [{ label: 'Long-term memory', text: 'MEM' }]).map((p) => p.label)).toEqual(['Turn context']);
  });
});

describe('staging', () => {
  const staged = { parts: [promptPart('static', 'role', 'Role', 'You are Octipus. [off-module]')], role: 'general', model: 'm' };

  test('the agent manager rewrites, adds and binds; the worker takes it exactly once', () => {
    stageRootPrompt('s1', staged);
    bindStagedRootPrompt('s1', 'agent-1', {
      rewrite: (t) => t.replace(' [off-module]', ''),
      add: [promptPart('static', 'skills', 'Selected skills', 'SKILL'), promptPart('static', 'tools', 'MCP servers', '')],
    });
    const taken = takeStagedRootPrompt('agent-1');
    expect(taken?.parts.map((p) => [p.label, p.text])).toEqual([['Role', 'You are Octipus.'], ['Selected skills', 'SKILL']]);
    expect(takeStagedRootPrompt('agent-1')).toBeUndefined();
    // Bound to the agent, so the session's next spawn cannot inherit it.
    bindStagedRootPrompt('s1', 'agent-2');
    expect(takeStagedRootPrompt('agent-2')).toBeUndefined();
  });
});

describe('measureRootRequest', () => {
  const tools = Array.from({ length: 13 }, (_, i) => ({ name: `tool_${i}`, description: 'd'.repeat(10 + i * 10), parameters: { type: 'object' } }));
  const history: AgentMessage[] = [
    msg('system', 'SYSTEM PROMPT — measured from the staged parts, not again here'),
    msg('user', '[Conversation checkpoint]\nWe chose pgvector.'),
    msg('user', 'Earlier question'),
    msg('assistant', '', { toolCalls: [{ id: 't1', name: 'web_fetch', arguments: { url: 'https://example.com' } }] }),
    msg('tool', 'x'.repeat(4_000), { name: 'web_fetch', toolCallId: 't1' }),
    msg('tool', 'y'.repeat(400), { name: 'read_file', toolCallId: 't2' }),
  ];
  const measure = () => measureRootRequest({
    staged: {
      parts: [
        promptPart('static', 'role', 'general role prompt', 'r'.repeat(400)),
        promptPart('static', 'guardrails', 'Security preamble', 'g'.repeat(200)),
        promptPart('static', 'workspace', 'Repo map', 'w'.repeat(80), { status: 'capped', note: '40 of 52 repos' }),
        promptPart('volatile', 'turn', 'Current date & time', 'd'.repeat(40)),
      ],
      role: 'general', model: 'm', contextWindow: 200_000, registeredToolCount: 40,
    },
    tools, history, userText: 'Which store should we use?', measuredAt: new Date('2026-11-08T10:00:00Z'),
  });

  test('sections come in category order and the tiers add up to the total', () => {
    const c = measure();
    const order = c.sections.map((s) => PROMPT_CATEGORIES.indexOf(s.category));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(c.totals.prefixTokens + c.totals.turnTokens + c.totals.historyTokens).toBe(c.totals.tokens);
    expect(c.totals.tokens).toBe(c.sections.reduce((n, s) => n + s.tokens, 0));
    expect(c).toMatchObject({ contextWindow: 200_000, toolCount: 13, registeredToolCount: 40, estimator: 'chars/4' });
  });

  test('the ten largest tools are listed, the rest folded with their names', () => {
    const toolRows = measure().sections.filter((s) => s.category === 'tools');
    expect(toolRows).toHaveLength(11);
    expect(toolRows[0].label).toBe('tool_12');
    expect(toolRows[10]).toMatchObject({ label: '3 more tools', count: 3, note: 'tool_2, tool_1, tool_0' });
  });

  test('history is split into checkpoint, tool results, assistant and user messages, system messages excluded', () => {
    const rows = measure().sections.filter((s) => s.tier === 'history');
    expect(rows.map((s) => s.label)).toEqual(['Checkpoint summary', 'Tool results', 'Assistant messages and tool calls', 'Earlier user messages']);
    expect(rows[1]).toMatchObject({ count: 2, note: 'largest: web_fetch, ~1,000 tokens' });
    expect(rows.some((s) => (s.text ?? '').includes('SYSTEM PROMPT'))).toBe(false);
  });

  test('caps travel with their section; the new message counts as this turn', () => {
    const c = measure();
    expect(c.sections.find((s) => s.label === 'Repo map')).toMatchObject({ status: 'capped', note: '40 of 52 repos' });
    expect(c.sections.find((s) => s.label === 'Your new message')).toMatchObject({ category: 'conversation', tier: 'volatile' });
    expect(tokensByCategory(c.sections).turn).toBe(10);
  });

  test('a retrieved block the turn did not repeat is not counted; the note that replaced it is', () => {
    const memory = '\n\nKnown about the user (long-term memory):\n' + 'm'.repeat(400);
    const c = measureRootRequest({
      staged: { parts: [promptPart('volatile', 'turn', 'Long-term memory', memory), promptPart('volatile', 'turn', 'Current date & time', 'd'.repeat(40))], role: 'general', model: 'm' },
      tools: [], history: [], userText: 'q', omitted: [memory.trim()],
    });
    const turn = c.sections.filter((s) => s.category === 'turn').map((s) => [s.label, s.note]);
    expect(turn).toHaveLength(2);
    expect(turn).toEqual(expect.arrayContaining([['Current date & time', undefined], ['Not repeated (already in the conversation)', 'Long-term memory']]));
  });

  test('the stored form keeps sizes and drops every text', () => {
    const stored = withoutText(measure());
    expect(JSON.stringify(stored)).not.toContain('rrrr');
    expect(stored.sections.every((s) => !('text' in s))).toBe(true);
  });
});

describe('latest composition', () => {
  test('is kept for a bounded number of sessions', () => {
    const composition = withoutText(measureRootRequest({ staged: { parts: [], role: 'general', model: 'm' }, tools: [], history: [], userText: 'hi' }));
    for (let i = 0; i < 60; i++) recordLatestComposition(`s-${i}`, { agentId: `a-${i}`, composition });
    expect(getLatestComposition('s-0')).toBeUndefined();
    expect(getLatestComposition('s-59')?.agentId).toBe('a-59');
  });
});

describe('agentPromptParts', () => {
  test('a worker prompt splits into guardrails, role, the per-run tail and what the manager appends, losing nothing', async () => {
    const { agentPromptParts } = await import('./prompt-parts');
    const prompt = `${SECURITY_PREAMBLE}${OUTPUT_FORMATTING_RULES}You research.\n\nCURRENT DATE & TIME: now\nUSER CONTEXT: x`;
    const parts = agentPromptParts(prompt, 'research', { selectedSkills: 'SKILL' });
    expect(parts.map((p) => [p.tier, p.category, p.label])).toEqual([
      ['static', 'guardrails', 'Security preamble'],
      ['static', 'guardrails', 'Output formatting'],
      ['static', 'role', 'research role prompt'],
      ['volatile', 'turn', 'Per-run context (date, profile, memories, workspace)'],
      ['static', 'skills', 'Selected skills'],
    ]);
    expect(parts.slice(0, 4).map((p) => p.text).join('')).toBe(prompt);
  });
});
