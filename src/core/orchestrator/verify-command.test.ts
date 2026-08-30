import { describe, expect, test } from 'vitest';
import { PRESET_TEMPLATES } from '@/db/seed-presets';
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
 */

const bugFix = PRESET_TEMPLATES.find((t) => t.name === 'Bug Fix');
const verifyStage = bugFix?.steps.find((s) => s.stageType === 'qa_validation');

describe('the shipped Bug Fix recipe', () => {
  test('takes a verify command as an optional parameter', () => {
    const param = bugFix?.parameters?.find((p) => p.key === 'verifyCommand');
    expect(param).toBeDefined();
    expect(param?.requirement).toBe('optional');
    expect(param?.default).toBe('');
  });

  test('the parameter description says what shape the command must be', () => {
    // The argv-only constraint is the one a model gets wrong by reflex, and
    // getting it wrong used to cost a whole child run.
    const param = bugFix?.parameters?.find((p) => p.key === 'verifyCommand');
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
});

describe('substitution', () => {
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
    expect(expandPromptTemplate(verifyStage?.verifyCommand ?? '', { 'param.verifyCommand': '' }).trim()).toBe('');
  });
});

describe('the prompt no longer sends the auditor looking', () => {
  test('it defers to the verify result when there is one', () => {
    expect(verifyStage?.promptTemplate).toMatch(/ground truth/i);
    expect(verifyStage?.promptTemplate).toMatch(/do not\s*\n?re-run it/i);
  });

  test('it still stands alone when there is not', () => {
    // Most callers will not pass a command, and that stage must still work.
    expect(verifyStage?.promptTemplate).toMatch(/Otherwise establish for yourself/i);
  });

  test('it still asks for a verdict the coverage gate can hold to account', () => {
    expect(verifyStage?.promptTemplate).toMatch(/FIXED \/ NOT FIXED \/ PARTIALLY FIXED/);
  });
});
