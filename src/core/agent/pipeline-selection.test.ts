/**
 * When the root is told to reach for the verified build loop — and that the two
 * places telling it agree.
 *
 * The loop this repo built (plan → implement → test → review → QA per item,
 * with a failed verdict routed back to the implementer) only ever runs behind
 * `create_pipeline`, and both surfaces that describe it used to gate it on the
 * user saying "staged". So the one primitive that verifies and re-does work was
 * unreachable for the request that needs it most — "implement the open points",
 * which is exactly the 2026-08-01 run that reported seven green stages over an
 * empty workspace.
 *
 * 2026-09-18 reversed the first half: the model no longer picks a pipeline at
 * all. It is the user's workflow in the user's order, so the delegation prompt
 * stopped describing it and the tool became `discoverOnly` — registered on every
 * root turn, advertised on none, reached through `list_tools` when the user asks
 * for staged work by name. What is asserted below is therefore the DESCRIPTION,
 * which is the rail the model reads after discovering it, and the prompt's
 * silence.
 *
 * The second half of this file is the more important half. `spawn_child`'s
 * schema told the parent a failed scorer meant "retry or correct" while the
 * delegation prompt told it never to respawn; the two shipped contradicting
 * each other for months, and nothing failed. A model reads both. So does this.
 */
import { describe, expect, test } from 'vitest';
import delegationPrompt from './delegation-prompt.md';
import { createMetaTools } from './meta-tools';
import { parseScorers } from '@/core/swarm/scorers';
import type { AgentNode } from '@/core/swarm/types';

/** The `create_pipeline` tool as the model receives it. */
function pipelineToolDescription(): string {
  const node = {
    id: 'root',
    rootSessionId: 's1',
    depth: 0,
    budget: {
      tokens: { cap: 200_000, used: 0 },
      wallClockMs: { cap: 600_000, startedAt: Date.now() },
      fanOut: { cap: 6, used: 0 },
      depth: 0,
    },
    allowedToolIds: new Set<string>(),
  } as unknown as AgentNode;
  const tools = createMetaTools({} as never, { parentNode: node });
  const tool = tools.find((t) => t.name === 'create_pipeline');
  expect(tool, 'create_pipeline must be on the root toolset').toBeDefined();
  return tool!.description ?? '';
}

describe('create_pipeline — the user chooses it, the description keeps it honest', () => {
  test('states the two conditions that make a pipeline right', () => {
    const d = pipelineToolDescription();
    // (a) several items that must be built, (b) done is settled by running.
    expect(d).toMatch(/items/i);
    expect(d).toMatch(/test suite|type-check|build/i);
  });

  test('no longer gates the loop on the user saying "staged"', () => {
    // This is the regression that made the loop unreachable. The phrasing may
    // change; requiring the user to have asked for staging must not come back.
    const d = pipelineToolDescription();
    expect(d).not.toMatch(/ONLY when the user EXPLICITLY asks/i);
    expect(d).not.toMatch(/LAST RESORT/);
    expect(delegationPrompt).not.toMatch(/Only when the user EXPLICITLY asks/i);
  });

  test('still refuses the shapes that have nothing to re-run', () => {
    // The opposite failure — every question becoming a seven-stage pipeline —
    // is the expensive one, so the exclusions are asserted as hard as the
    // inclusions.
    const d = pipelineToolDescription();
    expect(d).toMatch(/question|lookup|explanation/i);
    expect(d).toMatch(/read-only|audit/i);
    expect(d).toMatch(/ONCE per request/i);
  });

  test('the prompt hands the choice to the user and points at discovery', () => {
    // 2026-09-18: the model no longer picks a pipeline. It is the user's
    // workflow in the user's order, so the delegation prompt stopped describing
    // stages to choose between and names the way to find the tool instead. The
    // tool's own description is unchanged — it is the rail the model reads
    // AFTER the user has asked for one, which is when those exclusions matter.
    expect(delegationPrompt).toMatch(/order the USER sets/i);
    expect(delegationPrompt).toMatch(/list_tools/);
    expect(delegationPrompt).not.toMatch(/Use it when these stages justify/i);
  });

  test('the pipeline family is registered but never advertised', () => {
    const node = { id: 'root', rootSessionId: 's1', depth: 0,
      budget: { tokens: { cap: 1, used: 0 }, wallClockMs: { cap: 1, startedAt: 0 },
        fanOut: { cap: 1, used: 0 }, depth: 0 },
      allowedToolIds: new Set<string>() } as unknown as AgentNode;
    const tools = createMetaTools({} as never, { parentNode: node });
    for (const name of ['create_pipeline', 'list_pipeline_templates', 'list_recipes', 'invoke_recipe']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} must stay registered`).toBeDefined();
      expect(tool?.discoverOnly, `${name} must not be advertised up front`).toBe(true);
    }
  });

  test('says what the loop actually does, so the choice is informed', () => {
    const d = pipelineToolDescription();
    expect(d).toMatch(/per item|once per item/i);
    expect(d).toMatch(/back to the implementer/i);
  });
});

describe('the delegation prompt and the spawn surfaces agree', () => {
  test('the prompt tells the root that scorers exist and are enforced', () => {
    expect(delegationPrompt).toMatch(/scorers/);
    expect(delegationPrompt).toMatch(/command_exit_zero/);
    expect(delegationPrompt).toMatch(/contract_failed/);
  });

  test('the no-respawn rule and the automatic contract retry do not contradict', () => {
    // Both may be true at once, but only if the prompt says WHY: the framework
    // already re-dispatched the child once, so a `contract_failed` the root
    // sees is a twice-observed failure rather than an untried one. Without that
    // sentence the root reads "checks trigger a retry" next to "never respawn"
    // and has to guess which governs.
    expect(delegationPrompt).toMatch(/Do not blindly respawn/i);
    expect(delegationPrompt).toMatch(/Do not duplicate a retry already performed/i);
    expect(delegationPrompt).toMatch(/already been re-dispatched/i);
  });

  test('every scorer example in the prompt survives the real parser', () => {
    // Checked by round-tripping each example through `parseScorers` rather than
    // against a list copied into this file: a copied list is a second source of
    // truth for one fact, and the copy is the one that goes stale. The examples
    // are extracted whole, so a wrong FIELD is caught as well as a wrong kind.
    const examples = delegationPrompt.match(/\{"kind":"[^}]*\}/g) ?? [];
    expect(examples.length, 'the prompt should show scorer examples').toBeGreaterThan(0);
    for (const raw of examples) {
      const parsed = parseScorers([JSON.parse(raw)]);
      const err = 'error' in parsed ? parsed.error : undefined;
      expect(err, `prompt advertises a scorer the parser rejects: ${raw}`).toBeUndefined();
    }
  });
});
