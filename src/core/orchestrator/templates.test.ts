import { describe, expect, test } from 'bun:test';
import { expandPromptTemplate, parseRecipeExport } from './templates';

describe('expandPromptTemplate', () => {
  test('substitutes the existing description/previousOutput vars', () => {
    const out = expandPromptTemplate('Do {{description}} with {{previousOutput}}', {
      description: 'X',
      previousOutput: 'Y',
    });
    expect(out).toBe('Do X with Y');
  });

  test('substitutes dotted {{param.key}} vars literally (regex metachars escaped)', () => {
    const out = expandPromptTemplate('Repo: {{param.repo}}, env: {{param.env}}', {
      'param.repo': 'octipus',
      'param.env': 'prod',
    });
    expect(out).toBe('Repo: octipus, env: prod');
  });

  test('a dotted key does not match a different key by treating . as wildcard', () => {
    // {{param.repo}} must NOT be filled by a 'paramXrepo' value.
    const out = expandPromptTemplate('{{param.repo}}', { paramXrepo: 'WRONG' });
    expect(out).toBe('{{param.repo}}'); // unmatched, left intact
  });

  test('value containing $ is inserted literally (not treated as replacement special)', () => {
    const out = expandPromptTemplate('Cost: {{amount}}', { amount: '$5 for $1' });
    expect(out).toBe('Cost: $5 for $1');
  });

  test('repeated occurrences are all replaced', () => {
    expect(expandPromptTemplate('{{x}}-{{x}}', { x: 'a' })).toBe('a-a');
  });
});

describe('parseRecipeExport', () => {
  const valid = JSON.stringify({
    octipusRecipe: 1,
    name: 'My Recipe',
    description: 'desc',
    steps: [{ name: 'S1', topic: 'coding', toolIds: [], requiresApproval: false }],
    parameters: [{ key: 'repo', inputType: 'string', requirement: 'required' }],
  });

  test('parses a valid export', () => {
    const r = parseRecipeExport(valid);
    expect(r.name).toBe('My Recipe');
    expect(r.steps).toHaveLength(1);
    expect(r.parameters[0].key).toBe('repo');
  });

  test('rejects malformed JSON', () => {
    expect(() => parseRecipeExport('{not json')).toThrow(/invalid recipe JSON/);
  });

  test('rejects a wrong envelope', () => {
    expect(() => parseRecipeExport(JSON.stringify({ name: 'x', steps: [] }))).toThrow(/valid octipus recipe/);
  });

  test('rejects invalid parameter defs inside the export', () => {
    const bad = JSON.stringify({
      octipusRecipe: 1,
      name: 'x',
      steps: [],
      parameters: [{ key: 'env', inputType: 'select', requirement: 'optional' }], // no options
    });
    expect(() => parseRecipeExport(bad)).toThrow(/options/);
  });
});
