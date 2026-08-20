/**
 * Arm capability contracts. The point of these checks is that they must agree
 * with the post-run evidence gate: anything refused here would have been failed
 * there, and nothing the gate would accept is refused here.
 */
import { describe, expect, test } from 'bun:test';
import { PRESET_TEMPLATES } from '@/db/seed-presets';
import { stepConfigToStageTemplate } from './templates';
import { roleCapabilities, stageContractErrors, toolsetGaps } from './role-contract';
import type { StageTemplate } from './templates';

const stage = (over: Partial<StageTemplate>): StageTemplate => ({
  name: 'S',
  role: 'coding',
  requiresApproval: false,
  promptTemplate: 'x',
  ...over,
});

describe('roleCapabilities', () => {
  test('a writing role writes and runs', () => {
    expect(roleCapabilities('coding')).toEqual({ writesFiles: true, runsCommands: true });
  });

  test('read-only beats the toolset, even though the role keeps shell', () => {
    // `review` holds shell (it runs the checks it reviews against) but the
    // read-only strip is the contract — a shell escape hatch is a documented
    // ceiling of that defense, not a capability to build a stage on.
    expect(roleCapabilities('review')).toEqual({ writesFiles: false, runsCommands: true });
  });

  test('a role with neither filesystem nor shell writes nothing', () => {
    expect(roleCapabilities('orchestrator')).toEqual({ writesFiles: false, runsCommands: false });
  });
});

describe('stageContractErrors', () => {
  test('holds a stage to what it declares', () => {
    const errors = stageContractErrors([
      stage({ name: 'Review', role: 'review', producesArtifacts: true }),
      stage({ name: 'Ship', role: 'pm', runsCommands: true }),
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('read-only');
    expect(errors[1]).toContain('no shell tool');
  });

  test('an undeclared stage is never refused', () => {
    expect(stageContractErrors([stage({ role: 'pm' })])).toEqual([]);
  });

  test('a stage that narrows the shell away is as doomed as a role without one', () => {
    const errors = stageContractErrors([
      stage({ name: 'Test', role: 'qa', runsCommands: true, toolIds: ['filesystem', 'knowledge'] }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('declared toolIds');
  });

  test('narrowing to a single handler still counts as holding its group', () => {
    expect(
      stageContractErrors([stage({ role: 'qa', runsCommands: true, toolIds: ['shell__run'] })]),
    ).toEqual([]);
  });

  test('a human stage has no arm to hold to a contract', () => {
    expect(
      stageContractErrors([stage({ role: 'pm', stageType: 'human_input', runsCommands: true })]),
    ).toEqual([]);
  });
});

describe('toolsetGaps', () => {
  test('shell alone satisfies a writing purpose — the gate credits sed -i', () => {
    expect(toolsetGaps({ producesArtifacts: true }, ['shell__run'])).toEqual([]);
  });

  test('a write handler does not satisfy an executing purpose', () => {
    expect(toolsetGaps({ runsCommands: true }, ['filesystem__write_file'])).toHaveLength(1);
  });

  test('an emptied toolset fails both declarations', () => {
    expect(toolsetGaps({ producesArtifacts: true, runsCommands: true }, [])).toHaveLength(2);
  });

  test('no declaration, no check', () => {
    expect(toolsetGaps({}, [])).toEqual([]);
  });
});

// The shipped presets are what actually runs. A preset that declares work its
// role cannot do is now refused at pipeline creation, so it must not ship.
describe('shipped presets honor their own contracts', () => {
  for (const preset of PRESET_TEMPLATES) {
    test(`${preset.name}`, () => {
      expect(stageContractErrors(preset.steps.map(stepConfigToStageTemplate))).toEqual([]);
    });
  }
});
