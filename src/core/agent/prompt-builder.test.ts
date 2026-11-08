import { describe, expect, test } from 'vitest';
import { splitVolatileSystem } from '@/models/providers/prompt-cache';
import { type FrozenStatic, PromptBuilder } from './prompt-builder';

const DATE = '\n\nCURRENT DATE & TIME: Sun, 08 Nov 2026 12:00:00 GMT';
const scope = { generation: 'g1', checkpointId: 'c1' };

/** The root's shape: role prompt, delegation, then the session blocks, then the turn. */
function rootPrompt(listing: string, opts: { inlineUi?: boolean; memory?: string } = {}) {
  return new PromptBuilder()
    .add('user', 'role-prompt', 'SECURITY. PERSONA. You are the root agent.')
    .add('user', 'delegation-policy', '\n\nDelegate when…')
    .add('session', 'workspace-listing', `\nWORKSPACE: Root is /w\nProjects:\n${listing}`, { drifts: true })
    .add('session', 'inline-ui', opts.inlineUi ? '\n\nINLINE UI: you may render forms.' : '')
    .add('turn', 'turn-context', DATE)
    .add('turn', 'turn-context', opts.memory ?? '');
}

describe('tiers', () => {
  test('a wider tier after a narrower one is refused: the misplacement the two arrays let through', () => {
    const b = new PromptBuilder().add('session', 'workspace', 'x');
    expect(() => b.add('user', 'persona', 'y')).toThrow(/wider tier cannot follow/);
    expect(() => new PromptBuilder().add('turn', 'date', DATE).add('session', 'late', 'z')).toThrow(/wider tier/);
  });

  test('a static block carrying the date marker is refused: the worker would split inside it', () => {
    expect(() => new PromptBuilder().add('session', 'workspace', `oops${DATE}`)).toThrow(/date marker/);
  });

  test('the built prompt splits at the turn tier exactly, and empty blocks are dropped', () => {
    const b = rootPrompt('- api\n- web', { memory: '\n\nKnown about the user: likes tea' });
    const split = splitVolatileSystem(b.build());
    expect(split?.staticPart).toBe(b.staticParts().join(''));
    expect(b.staticParts()).toHaveLength(3); // no inline-ui block
    expect(b.turnParts()).toHaveLength(2);
  });

  test('the summary names the tier that moved', () => {
    const a = rootPrompt('- api').summary();
    const b = rootPrompt('- api\n- new-dir').summary();
    const byTier = (s: typeof a, t: string) => s.find((x) => x.tier === t)!;
    expect(byTier(b, 'user').fingerprint).toBe(byTier(a, 'user').fingerprint);
    expect(byTier(b, 'session').fingerprint).not.toBe(byTier(a, 'session').fingerprint);
    expect(byTier(a, 'session').labels).toEqual(['workspace-listing']);
    expect(byTier(a, 'user').tokens).toBeGreaterThan(0);
  });
});

describe('the drifting session blocks are replayed for the conversation', () => {
  test('a new directory on disk leaves the cached prefix byte-identical', () => {
    const first = rootPrompt('- api');
    const { frozen, replayed } = first.freezeDrift(undefined, scope);
    expect(replayed).toBe(false);

    const later = rootPrompt('- api\n- scratch-dir-the-agent-made', { memory: '\n\nnew memory' });
    const again = later.freezeDrift(frozen, scope);
    expect(again.replayed).toBe(true);
    expect(again.frozen).toBe(frozen); // nothing to store
    expect(later.staticParts().join('')).toBe(first.staticParts().join(''));
    // The turn tier is this turn's own.
    expect(later.build()).toContain('new memory');
  });

  test('a clear or a checkpoint rebuilds it (the cache resets there anyway)', () => {
    const { frozen } = rootPrompt('- api').freezeDrift(undefined, scope);
    for (const next of [{ generation: 'g2', checkpointId: 'c1' }, { generation: 'g1', checkpointId: 'c2' }, { generation: 'g1' }]) {
      const b = rootPrompt('- api\n- web');
      const r = b.freezeDrift(frozen, next);
      expect(r.replayed).toBe(false);
      expect(b.build()).toContain('- web');
      expect(r.frozen).toMatchObject({ generation: next.generation, drift: { 'workspace-listing': expect.stringContaining('- web') } });
    }
  });

  test('a change to the session tier\'s shape rebuilds it', () => {
    const { frozen } = rootPrompt('- api').freezeDrift(undefined, scope);
    const b = rootPrompt('- api\n- web', { inlineUi: true });
    expect(b.freezeDrift(frozen, scope).replayed).toBe(false);
    expect(b.build()).toContain('- web');
  });

  test('a dropped frozen value (scan_repos) rebuilds it', () => {
    const b = rootPrompt('- api\n- web');
    expect(b.freezeDrift(null as unknown as FrozenStatic | undefined, scope).replayed).toBe(false);
  });
});
