import { describe, expect, test } from 'vitest';
import { planPresetReconcile } from './seed-presets';

// A preset was insert-once-and-never-again: user edits survived a restart
// (correct) but so did stale prompts, so every shipped prompt/toolIds change
// needed a throwaway script to push into the stored row and a real install
// would simply never receive it. These are the four cases that fixes it —
// including the one that must NOT fire.
describe('planPresetReconcile', () => {
  const shipped = [
    { name: 'Implementation', topic: 'coding', toolIds: ['filesystem'], requiresApproval: false, promptTemplate: 'v2' },
  ];
  const asShippedBefore = [
    { name: 'Implementation', topic: 'coding', toolIds: ['filesystem'], requiresApproval: false, promptTemplate: 'v1' },
  ];
  // The hash the seeder would have written when it last shipped `v1`.
  const v1Hash = (() => {
    const p = planPresetReconcile(asShippedBefore, null, asShippedBefore);
    if (p.action !== 'adopt') throw new Error('expected adopt');
    return p.shippedHash;
  })();

  test('refreshes a preset the user never touched', () => {
    const plan = planPresetReconcile(asShippedBefore, v1Hash, shipped);
    expect(plan.action).toBe('refresh');
    expect(plan.action === 'refresh' && plan.steps[0].promptTemplate).toBe('v2');
  });

  test('never overwrites an edited preset — it only gains missing flags', () => {
    const edited = [{ ...asShippedBefore[0], promptTemplate: 'MINE' }];
    const plan = planPresetReconcile(edited, v1Hash, [{ ...shipped[0], producesArtifacts: true }]);
    expect(plan.action).toBe('backfill');
    expect(plan.action === 'backfill' && plan.steps[0].promptTemplate).toBe('MINE');
    expect(plan.action === 'backfill' && plan.steps[0].producesArtifacts).toBe(true);
  });

  test('a legacy row with no hash is treated as edited, not clobbered', () => {
    const plan = planPresetReconcile(asShippedBefore, null, shipped);
    expect(plan.action).not.toBe('refresh');
  });

  test('a legacy row whose content already matches adopts the hash', () => {
    // How an install seeded before the column existed stops being frozen: once
    // its content lines up with what ships, it records the hash and becomes
    // refreshable from then on.
    expect(planPresetReconcile(shipped, null, shipped).action).toBe('adopt');
  });

  test('the steady state writes nothing', () => {
    const adopted = planPresetReconcile(shipped, null, shipped);
    if (adopted.action !== 'adopt') throw new Error('expected adopt');
    expect(planPresetReconcile(shipped, adopted.shippedHash, shipped).action).toBe('noop');
  });

  // The bug the other tests could not see: they build `stored` and `shipped`
  // as JS literals in the SAME key order, but `steps` is a jsonb column and
  // Postgres re-serializes object keys sorted by length then lexicographically.
  // Hashing `JSON.stringify` directly therefore made every stored preset look
  // EDITED from the second boot onward — the exact "preset changes ship dead"
  // failure this hash exists to end. Reordering the keys here is the cheap
  // stand-in for that round trip.
  const reorderKeys = <T,>(steps: T[]): T[] =>
    steps.map((s) => {
      const src = s as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort((a, b) => b.length - a.length)) out[k] = src[k];
      return out as T;
    });

  test('key order from the jsonb round-trip does not make a preset look edited', () => {
    const roundTripped = reorderKeys(asShippedBefore);
    expect(JSON.stringify(roundTripped)).not.toBe(JSON.stringify(asShippedBefore));
    // Same content, keys in the order Postgres hands back — must still refresh.
    expect(planPresetReconcile(roundTripped, v1Hash, shipped).action).toBe('refresh');
  });

  test('a legacy row read back from jsonb still adopts the hash', () => {
    expect(planPresetReconcile(reorderKeys(shipped), null, shipped).action).toBe('adopt');
  });

  test('a refresh is idempotent — the second boot is a no-op', () => {
    const first = planPresetReconcile(asShippedBefore, v1Hash, shipped);
    if (first.action !== 'refresh') throw new Error('expected refresh');
    expect(planPresetReconcile(first.steps, first.shippedHash, shipped).action).toBe('noop');
  });
});
