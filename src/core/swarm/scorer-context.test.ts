import { describe, expect, it } from 'vitest';
import { routeApproval } from '@/security/approval-policy';
import { buildScorerContext } from './spawner';
import type { ToolHandler } from '@/core/agent-base';

/**
 * The context a spawned child's gates actually run under.
 *
 * Every field here is one a hand-written test got right while production got it
 * wrong. `role` was missing on the real path, and `canPromptHuman` reads an
 * ABSENT role as "can ask a human" — which routed the shipped ASK level on
 * `shell.execute` to `ask_human` and made every `command_exit_zero` gate refuse
 * on a stock install. The scorer tests could not catch it: they built their own
 * context and supplied a role.
 */
const tool = (name: string, toolId?: string) => ({ name, toolId }) as ToolHandler;

describe('buildScorerContext', () => {
  it('carries the role, so an ASK permission is not read as promptable', () => {
    const ctx = buildScorerContext({
      userId: 'u1',
      filesTouched: null,
      childTools: [tool('shell__run', 'shell')],
      childRole: 'coding' as never,
    });

    expect(ctx.role).toBe('coding');
    // The consequence, asserted through the real decision function rather than
    // restated: with this context ASK executes; without a role it would ask a
    // human that is not there.
    const withRole = routeApproval({
      level: 'ASK',
      role: ctx.role,
      root: false,
      attended: false,
      toolId: 'shell',
      action: 'shell__run',
    });
    expect(withRole.route).toBe('execute');

    const withoutRole = routeApproval({
      level: 'ASK',
      role: undefined,
      root: false,
      attended: false,
      toolId: 'shell',
      action: 'shell__run',
    });
    expect(withoutRole.route).toBe('ask_human');
  });

  it('reports the shell capability from the resolved toolset', () => {
    const held = buildScorerContext({
      filesTouched: null,
      childTools: [tool('shell__run', 'shell'), tool('filesystem__read_file', 'filesystem')],
      childRole: 'coding' as never,
    });
    expect(held.canRunCommands).toBe(true);

    // A role whose shell was intersected away, or capped off by the
    // small-model tool cap, must read as not holding it.
    const withheld = buildScorerContext({
      filesTouched: null,
      childTools: [tool('websearch__search', 'websearch')],
      childRole: 'research' as never,
    });
    expect(withheld.canRunCommands).toBe(false);
  });

  it('passes the run signal through', () => {
    const signal = new AbortController().signal;
    const ctx = buildScorerContext({
      filesTouched: 3,
      childTools: [],
      childRole: 'coding' as never,
      signal,
    });
    expect(ctx.signal).toBe(signal);
    expect(ctx.filesTouched).toBe(3);
  });
});
