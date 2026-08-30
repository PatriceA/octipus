import { describe, expect, test } from 'vitest';
import { planProducesArtifactsBackfill, PRESET_TEMPLATES } from '@/db/seed-presets';
import { isFinalPlanItem } from './pipeline-manager';
import { validateRecipeParameterRefs } from './recipe-params';
import { expandPromptTemplate } from './templates';

/**
 * A verify stage should be handed the command that settles the question, not a
 * checklist telling it to work one out.
 *
 * `runsCommands` declared THAT a stage runs something and never WHAT, so the
 * Bug Fix verify stage carried a numbered list — "run the regression test, run
 * the full suite, try the original repro, check for edge cases" — and spent its
 * iterations rediscovering the command every time. Measured at 4 iterations and
 * 82,783 tokens to establish that a 13-test suite passes in a millisecond.
 *
 * The command cannot be a template default: no recipe knows another project's
 * test runner, and a wrong guess fails every run that does not happen to use
 * it. So it is an optional recipe parameter, and an empty one changes nothing.
 *
 * Every recipe with a `qa_validation` stage takes it. It shipped on Bug Fix
 * alone, which left the Full Development Cycle auditor — the one that runs on
 * every plan item — still rediscovering the command on each pass.
 */

const RECIPES = ['Bug Fix', 'Full Development Cycle'] as const;

describe.each(RECIPES)('the shipped %s recipe', (name) => {
  const recipe = PRESET_TEMPLATES.find((t) => t.name === name);
  const param = recipe?.parameters?.find((p) => p.key === 'verifyCommand');
  const verifyStage = recipe?.steps.find((s) => s.stageType === 'qa_validation');

  test('takes a verify command as an optional parameter', () => {
    expect(param).toBeDefined();
    expect(param?.requirement).toBe('optional');
    expect(param?.default).toBe('');
  });

  test('the parameter description says what shape the command must be', () => {
    // The argv-only constraint is the one a model gets wrong by reflex, and
    // getting it wrong used to cost a whole child run.
    expect(param?.description).toMatch(/argv|no pipes|leading cd/i);
  });

  test('the verify stage declares it', () => {
    expect(verifyStage?.verifyCommand).toBe('{{param.verifyCommand}}');
  });

  test('the stage still declares that it runs commands', () => {
    // `runsCommands` is the after-the-fact check that catches a simulated test
    // run. `verifyCommand` does not replace it.
    expect(verifyStage?.runsCommands).toBe(true);
  });

  test('a supplied command reaches the stage', () => {
    expect(
      expandPromptTemplate(verifyStage?.verifyCommand ?? '', {
        'param.verifyCommand': 'python3 -m unittest discover',
      }),
    ).toBe('python3 -m unittest discover');
  });

  test('an omitted command expands to nothing, and nothing runs', () => {
    // The default case: no parameter, no framework-run command, behaviour
    // exactly as it shipped.
    expect(
      expandPromptTemplate(verifyStage?.verifyCommand ?? '', { 'param.verifyCommand': '' }).trim(),
    ).toBe('');
  });

  test('the prompt defers to the verify result when there is one', () => {
    expect(verifyStage?.promptTemplate).toMatch(/ground truth/i);
    expect(verifyStage?.promptTemplate).toMatch(/do not\s*\n?re-run it/i);
  });

  test('the prompt still stands alone when there is not', () => {
    // Most callers will not pass a command, and that stage must still work.
    expect(verifyStage?.promptTemplate).toMatch(/Otherwise establish for yourself/i);
  });
});

describe('the Bug Fix verdict contract', () => {
  const verifyStage = PRESET_TEMPLATES.find((t) => t.name === 'Bug Fix')?.steps.find(
    (s) => s.stageType === 'qa_validation',
  );
  test('it still asks for a verdict the coverage gate can hold to account', () => {
    expect(verifyStage?.promptTemplate).toMatch(/FIXED \/ NOT FIXED \/ PARTIALLY FIXED/);
  });
});

/**
 * Reachability, not just correctness. An install that edited its preset takes
 * the backfill path, where the new recipe parameter lands but the shipped steps
 * do not — so without this the parameter would be offered and then ignored.
 */
describe('an install that edited its preset', () => {
  const shipped = PRESET_TEMPLATES.find((t) => t.name === 'Full Development Cycle')?.steps ?? [];
  const stored = shipped.map((s) =>
    s.stageType === 'qa_validation'
      ? { ...s, verifyCommand: undefined, promptTemplate: 'edited by the user' }
      : s,
  );

  test('gets the verify command backfilled onto its auditor', () => {
    const { steps, changed } = planProducesArtifactsBackfill(stored, shipped);
    expect(changed).toBe(true);
    expect(steps.find((s) => s.stageType === 'qa_validation')?.verifyCommand).toBe(
      '{{param.verifyCommand}}',
    );
  });

  test('but an explicit empty command is the user opting out, and survives', () => {
    const optedOut = stored.map((s) =>
      s.stageType === 'qa_validation' ? { ...s, verifyCommand: '' } : s,
    );
    const { steps } = planProducesArtifactsBackfill(optedOut, shipped);
    expect(steps.find((s) => s.stageType === 'qa_validation')?.verifyCommand).toBe('');
  });
});

/**
 * The two ways an unresolved `{{param.verifyCommand}}` could reach the shell,
 * where the exit code of a literal placeholder would be handed to the auditor
 * as the ground truth it is told not to re-check.
 */
describe('an unresolved reference never becomes a command', () => {
  const steps = [{ name: 'QA Validation', verifyCommand: '{{param.verifyCommand}}' }];

  test('a recipe that declares the parameter validates', () => {
    expect(() =>
      validateRecipeParameterRefs(steps, [
        { key: 'verifyCommand', inputType: 'string', requirement: 'optional', default: '' },
      ]),
    ).not.toThrow();
  });

  test('a recipe whose steps were copied without its parameters fails loud', () => {
    // `scripts/seed-cli-pipeline.ts` clones the shipped steps; a user template
    // built by copy-paste does the same. Before this the reference was only
    // ever checked in `promptTemplate`.
    expect(() => validateRecipeParameterRefs(steps, [])).toThrow(/undeclared recipe parameter/);
  });
});

/**
 * A project-wide verify command on a `loopOverPlan` auditor runs once, at the
 * end — not once per item against a plan that is still being built out.
 */
describe('the plan loop', () => {
  const items = [{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }];

  test('an early item is not the last one', () => {
    expect(isFinalPlanItem(items, { ordinal: 0 })).toBe(false);
  });

  test('the highest ordinal is', () => {
    expect(isFinalPlanItem(items, { ordinal: 2 })).toBe(true);
  });

  test('an item the plan grew past stops being the last one', () => {
    // `plan__add_items` extends the plan mid-run, so "last" cannot be decided
    // once and cached.
    expect(isFinalPlanItem([...items, { ordinal: 3 }], { ordinal: 2 })).toBe(false);
  });
});
