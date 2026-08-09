import { describe, expect, test } from 'bun:test';
import { buildStagesFromTemplate, expandPromptTemplate, parseRecipeExport, stepConfigToStageTemplate } from './templates';

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

// A stage's DECLARATIONS have to survive the trip from the stored template to
// the gate that reads them. `stepConfigToStageTemplate` and
// `buildStagesFromTemplate` both enumerate fields, so a flag nobody adds to
// those lists is dropped silently: the template declares it, the gate never
// hears about it, and the stage passes ungated while looking configured.
//
// That is not hypothetical — it happened to `runsCommands` on its first live
// run. The Testing stage carried the declaration in the DB, wrote no evidence
// row at all, and the simulation hole it was written to close stayed open.
describe('stage declarations survive the template round-trip', () => {
  const step = {
    name: 'Testing',
    topic: 'qa',
    toolIds: ['shell'],
    requiresApproval: false,
    producesArtifacts: true,
    runsCommands: true,
  };

  test('the declared toolIds reach the built stage, not the role defaults', () => {
    // The fourth declaration to go missing this way, and the most damaging:
    // `Research & Discovery` declares browser+websearch, silently ran with its
    // role's full surface, and delegated to a child that wrote the entire
    // product before `Implementation` ever started.
    const [built] = buildStagesFromTemplate(
      { type: 't', stages: [stepConfigToStageTemplate(step)], parameters: [] },
      'a task',
    );
    expect(built.toolIds).toEqual(['shell']);
  });

  test('a stage with no declared tools falls back to its role defaults', () => {
    const noTools = { name: 'Testing', topic: 'qa', toolIds: [], requiresApproval: false };
    const [built] = buildStagesFromTemplate(
      { type: 't', stages: [stepConfigToStageTemplate(noTools)], parameters: [] },
      'a task',
    );
    // Not the empty list: a stage that declares nothing is unconstrained, and a
    // toolless worker fails in a way that looks like the model refusing to work.
    expect(built.toolIds.length).toBeGreaterThan(0);
  });

  // One fully-populated step, checked KEY BY KEY through both mappers, instead
  // of one assertion per flag. Adding a declaration to `PipelineStepConfig` now
  // costs one line here and the round trip is guarded automatically — which is
  // the shape this bug keeps exploiting: the guard enumerated fields too, so a
  // new flag was missing from the mapper AND from the test that checks mappers.
  const everyDeclaration = {
    name: 'Implementation',
    topic: 'coding',
    toolIds: ['shell'],
    requiresApproval: true,
    promptTemplate: 'do the thing',
    stageType: 'qa_validation' as const,
    maxRetries: 2,
    retryTargetStage: 1,
    model: 'some-model',
    producesArtifacts: true,
    runsCommands: true,
    readOnly: true,
    mechanical: true,
  };
  // Carried under a different name (`topic` → `role`) or deliberately not
  // carried at all — everything else must survive byte for byte.
  const RENAMED_OR_DROPPED = new Set(['topic', 'description']);

  test('stepConfigToStageTemplate drops no declaration', () => {
    const mapped = stepConfigToStageTemplate(everyDeclaration) as unknown as Record<string, unknown>;
    for (const key of Object.keys(everyDeclaration)) {
      if (RENAMED_OR_DROPPED.has(key)) continue;
      expect([key, mapped[key]]).toEqual([key, (everyDeclaration as Record<string, unknown>)[key]]);
    }
    expect(mapped.role).toBe('coding');
  });

  test('buildStagesFromTemplate drops no declaration', () => {
    const [built] = buildStagesFromTemplate(
      { type: 't', stages: [stepConfigToStageTemplate(everyDeclaration)], parameters: [] },
      'a task',
    ) as unknown as Array<Record<string, unknown>>;
    for (const key of Object.keys(everyDeclaration)) {
      if (RENAMED_OR_DROPPED.has(key)) continue;
      expect([key, built[key]]).toEqual([key, (everyDeclaration as Record<string, unknown>)[key]]);
    }
  });

  test('an undeclared stage stays undeclared — the gate must not invent a claim', () => {
    const plain = { name: 'Research', topic: 'research', toolIds: [], requiresApproval: false };
    const [built] = buildStagesFromTemplate(
      { type: 't', stages: [stepConfigToStageTemplate(plain)], parameters: [] },
      'a task',
    );
    expect(built.producesArtifacts).toBeUndefined();
    expect(built.runsCommands).toBeUndefined();
    expect(built.readOnly).toBeUndefined();
    expect(built.mechanical).toBeUndefined();
  });
});
