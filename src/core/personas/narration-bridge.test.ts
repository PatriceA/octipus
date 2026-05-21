import { describe, expect, test } from 'bun:test';
import { renderNarration } from './resolver';
import type { ResolvedPersona } from './types';

// The narration BRIDGE end-to-end test requires a live gateway hub
// and DB. The pure rendering logic is the only thing worth unit-testing
// here — bridge wiring is covered by the persona-hook tests and an
// integration test.

describe('narration template rendering — coverage', () => {
  const make = (overrides: Partial<ResolvedPersona> = {}): ResolvedPersona => ({
    id: 'octipus',
    name: 'Octipus',
    pronouns: 'it/we',
    tone: 'dry',
    promptBlock: 'PERSONA',
    narration: 'minimal',
    narrationTemplates: {
      spawn_single: 'Octipus dispatches a {{role}} arm {{verb}}.',
      spawn_parallel: 'Octipus deploys {{count}} arms in parallel.',
      completion_ok: '{{role}} returned. {{summary_one_liner}}',
      completion_error: '{{role}} failed. {{error_line}}. Predictable.',
      approval_request: 'Decision required: {{question}}',
      budget_warning: 'Token budget at 80%.',
    },
    signaturePhrases: [],
    userFacts: [],
    presetId: 'octipus',
    ...overrides,
  });

  test('spawn_single fills role and verb', () => {
    const text = renderNarration(make(), 'spawn_single', { role: 'research', verb: 'to look into this' });
    expect(text).toBe('Octipus dispatches a research arm to look into this.');
  });

  test('spawn_parallel uses count', () => {
    const text = renderNarration(make(), 'spawn_parallel', { role: 'mixed', count: 3 });
    expect(text).toBe('Octipus deploys 3 arms in parallel.');
  });

  test('approval_request surfaces the question', () => {
    const text = renderNarration(make(), 'approval_request', { question: 'Continue with destructive migration?' });
    expect(text).toBe('Decision required: Continue with destructive migration?');
  });

  test('budget_warning takes no substitution', () => {
    const text = renderNarration(make(), 'budget_warning', {});
    expect(text).toBe('Token budget at 80%.');
  });

  test('renames carry through to renderer', () => {
    const text = renderNarration(
      make({
        name: 'Adam',
        narrationTemplates: { spawn_single: '{{name}} sends a {{role}} arm.' },
      }),
      'spawn_single',
      { role: 'qa' },
    );
    expect(text).toBe('Adam sends a qa arm.');
  });
});
