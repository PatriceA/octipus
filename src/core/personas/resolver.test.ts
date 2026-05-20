import { afterEach, describe, expect, test } from 'bun:test';
import { getPersonaRegistry } from './registry';
import { renderNarration } from './resolver';
import { Persona, type ResolvedPersona } from './types';

const mkPersona = (id: string, opts: Partial<Persona> = {}): Persona => Persona.parse({
  id,
  is_default: id === 'octipus',
  display_name: opts.display_name ?? id,
  name: opts.name ?? 'Octipus',
  pronouns: opts.pronouns ?? 'it/we',
  tone: opts.tone ?? 'dry',
  persona_prompt: opts.persona_prompt ?? 'You are Octipus, the octopus-machine. Refer to yourself in third person.',
  signature_phrases: opts.signature_phrases ?? [],
  narration_templates: opts.narration_templates ?? {
    spawn_single: 'Octipus dispatches a {{role}} arm.',
    completion_ok: '{{role}} returned. {{summary_one_liner}}',
    completion_error: '{{role}} failed. {{error_line}}. Predictable.',
  },
});

describe('renderNarration', () => {
  afterEach(() => getPersonaRegistry()._resetForTesting());

  const baseResolved = (overrides: Partial<ResolvedPersona> = {}): ResolvedPersona => ({
    id: 'octipus',
    name: 'Octipus',
    pronouns: 'it/we',
    tone: 'dry',
    promptBlock: 'PERSONA BLOCK',
    narration: 'minimal',
    narrationTemplates: {
      spawn_single: 'Octipus dispatches a {{role}} arm.',
      completion_ok: '{{role}} returned. {{summary_one_liner}}',
      completion_error: '{{role}} failed. {{error_line}}. Predictable.',
    },
    signaturePhrases: [],
    userFacts: [],
    presetId: 'octipus',
    ...overrides,
  });

  test('substitutes role + name in spawn template', () => {
    const text = renderNarration(baseResolved(), 'spawn_single', { role: 'research' });
    expect(text).toBe('Octipus dispatches a research arm.');
  });

  test('substitutes name when renamed', () => {
    const text = renderNarration(
      baseResolved({
        name: 'Adam',
        narrationTemplates: { spawn_single: '{{name}} sends a {{role}} arm.' },
      }),
      'spawn_single',
      { role: 'research' },
    );
    expect(text).toBe('Adam sends a research arm.');
  });

  test('returns null when narration is off', () => {
    const text = renderNarration(
      baseResolved({ narration: 'off' }),
      'spawn_single',
      { role: 'research' },
    );
    expect(text).toBeNull();
  });

  test('returns null when template missing', () => {
    const text = renderNarration(
      baseResolved({ narrationTemplates: {} }),
      'spawn_single',
      { role: 'x' },
    );
    expect(text).toBeNull();
  });

  test('handles completion_error with error_line', () => {
    const text = renderNarration(
      baseResolved(),
      'completion_error',
      { role: 'qa', error_line: 'tests crashed' },
    );
    expect(text).toBe('qa failed. tests crashed. Predictable.');
  });

  test('empty for unrecognized placeholder', () => {
    const text = renderNarration(
      baseResolved({
        narrationTemplates: { spawn_single: 'X={{missing}}' },
      }),
      'spawn_single',
      {},
    );
    expect(text).toBe('X=');
  });

  // For mkPersona — typecheck only, no behavior to assert
  test('mkPersona helper produces valid persona', () => {
    const p = mkPersona('test');
    expect(p.id).toBe('test');
  });
});
