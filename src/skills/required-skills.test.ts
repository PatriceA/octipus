import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SkillView } from '@/db/schema/skills';

const decide = vi.fn();
vi.mock('@/models/decision', () => ({ decide: (...args: unknown[]) => decide(...args) }));

const visible = new Map<string, SkillView>();
vi.mock('./registry', () => ({
  getSkillRegistry: () => ({
    canonicalId: (id: string) => id,
    getByIds: async (ids: string[]) => ids.map((id) => visible.get(id)).filter(Boolean),
    buildPromptFragment: async (ids: string[]) => ids.map((id) => `## ${visible.get(id)?.name}\n\nbody of ${id}`).join('\n\n'),
  }),
}));

const { decideTaskSkills, resolveDeclaredSkills, buildRequiredSkillsPrompt } = await import('./required-skills');

const skill = (id: string, name = id): SkillView => ({ id, name, description: `${name} skill` }) as SkillView;

beforeEach(() => {
  decide.mockReset();
  visible.clear();
});

describe('decideTaskSkills', () => {
  test('keeps only confident yeses, best first', async () => {
    decide.mockResolvedValue({
      s1: { type: 'noul', p: 0.85, confidence: 0.9 },
      s2: { type: 'noul', p: 0.2, confidence: 0.95 },
      s3: { type: 'noul', p: 0.97, confidence: 0.97 },
      // A yes the model is unsure of is not a yes.
      s4: { type: 'noul', p: 0.9, confidence: 0.5 },
    });
    const picked = await decideTaskSkills('write the migration', 'coding', [skill('a'), skill('b'), skill('c'), skill('d')]);
    expect(picked.map((s) => s.id)).toEqual(['c', 'a']);
  });

  test('asks one independent question per candidate, at a local-only site', async () => {
    decide.mockResolvedValue(null);
    await decideTaskSkills('task', 'coding', [skill('a'), skill('b')]);
    const [site, state, questions] = decide.mock.calls[0];
    expect(site).toMatchObject({ id: 'skills.select', sensitivity: 'secret' });
    expect(Object.keys(questions)).toEqual(['s1', 's2']);
    expect(state).toMatchObject({ role: 'coding', task: 'task' });
  });

  test('no decision model (null) adds nothing', async () => {
    decide.mockResolvedValue(null);
    expect(await decideTaskSkills('task', 'coding', [skill('a')])).toEqual([]);
  });

  test('caps the candidates it asks about', async () => {
    decide.mockResolvedValue(null);
    await decideTaskSkills('task', 'coding', Array.from({ length: 20 }, (_, i) => skill(`s${i}`)));
    expect(Object.keys(decide.mock.calls[0][2])).toHaveLength(8);
  });

  test('no candidates, no call', async () => {
    expect(await decideTaskSkills('task', 'coding', [])).toEqual([]);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('declared skills', () => {
  test('resolve in declared order', async () => {
    visible.set('a', skill('a', 'Alpha'));
    visible.set('b', skill('b', 'Beta'));
    expect((await resolveDeclaredSkills(['b', 'a', 'b'], 'u')).map((s) => s.id)).toEqual(['b', 'a']);
  });

  test('a missing skill fails loud instead of running without it', async () => {
    visible.set('a', skill('a'));
    await expect(resolveDeclaredSkills(['a', 'gone'], 'u')).rejects.toThrow('Required skill unavailable: gone');
  });

  test('the prompt section carries the full bodies', async () => {
    visible.set('a', skill('a', 'Alpha'));
    const prompt = await buildRequiredSkillsPrompt(['a'], 'u');
    expect(prompt).toContain('# Required skills');
    expect(prompt).toContain('body of a');
    expect(await buildRequiredSkillsPrompt([], 'u')).toBe('');
  });
});
