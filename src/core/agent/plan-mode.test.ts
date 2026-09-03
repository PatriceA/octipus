import { describe, expect, test } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import { FILE_CHANGE_TOOLS } from '@/core/tool-executor';
import { isPlanMode, PLAN_MODE_DIRECTIVE, stripMutatingTools } from './plan-mode';

/**
 * Octipus had a `plan` TOOLBOX — `add_items`/`list_items`/`update_item` over a
 * running pipeline's work list — and no plan MODE. Nothing stopped an agent
 * asked to plan from writing files while it planned, so "just plan it first"
 * was a request the model could decline by getting on with the work.
 *
 * A mode is only as strong as its weakest part, so all three are pinned here:
 * the tools are actually withheld, the instruction says what the filter cannot
 * enforce, and the mode is inherited rather than being a property of one agent.
 */

const handler = (name: string): ToolHandler => ({
  name,
  description: name,
  parameters: {},
  execute: async () => null,
});

describe('what a planning turn may hold', () => {
  test('every file-mutating handler is withheld', () => {
    const tools = [...FILE_CHANGE_TOOLS].map(handler);
    expect(stripMutatingTools(tools)).toEqual([]);
  });

  test('reading, searching and running are untouched', () => {
    // Plan mode explores. A mode that cannot read the code produces a plan
    // about a codebase it never looked at.
    const keep = ['filesystem__read_file', 'filesystem__list_directory', 'shell__run', 'knowledge__search'];
    const kept = stripMutatingTools(keep.map(handler)).map((h) => h.name);
    expect(kept).toEqual(keep);
  });

  test('the filter uses the SAME list as the read-only roles', () => {
    // Two lists of "what counts as a write" drift, and the one that drifts is
    // the one nobody is looking at.
    const written = stripMutatingTools([handler('filesystem__write_file')]);
    expect(written).toEqual([]);
    expect(FILE_CHANGE_TOOLS.has('filesystem__write_file')).toBe(true);
  });
});

describe('reading the mode', () => {
  test('only an explicit true counts', () => {
    expect(isPlanMode({ planMode: true })).toBe(true);
    expect(isPlanMode({ planMode: false })).toBe(false);
    expect(isPlanMode({})).toBe(false);
    expect(isPlanMode(undefined)).toBe(false);
  });
});

describe('what the instruction has to say', () => {
  test('it names the routes the tool filter cannot close', () => {
    // `shell` survives the filter by design — a planning turn needs to run
    // tests — so a redirect is still reachable and has to be ruled out in
    // words. The read-only role comment has always said this; plan mode says
    // it to the model.
    expect(PLAN_MODE_DIRECTIVE).toMatch(/redirect|tee|>/);
    expect(PLAN_MODE_DIRECTIVE).toMatch(/commit/i);
  });

  test('it says agreement is not approval', () => {
    // The failure mode that makes a plan mode fake: the user says "sounds
    // good" and the agent treats that as the end of planning.
    expect(PLAN_MODE_DIRECTIVE).toMatch(/approves nothing|not.*approval/i);
  });

  test('it names the only exit', () => {
    expect(PLAN_MODE_DIRECTIVE).toMatch(/exit_plan_mode/);
    expect(PLAN_MODE_DIRECTIVE).toMatch(/ONLY way out/i);
  });

  test('it tells the agent to explore before proposing', () => {
    expect(PLAN_MODE_DIRECTIVE).toMatch(/explore/i);
  });
});
