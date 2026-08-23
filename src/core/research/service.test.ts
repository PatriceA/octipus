import { describe, expect, test } from 'vitest';
import { runResearch, type ResearchDeps } from './service';

const NOW = '2026-06-03T12:00:00Z';

function fakeDeps(over: Partial<ResearchDeps> = {}): ResearchDeps {
  return {
    now: () => NOW,
    search: async (q) => [
      { title: `Result for ${q}`, url: `https://src.example/${encodeURIComponent(q)}`, snippet: 'snippet text' },
    ],
    fetchText: async (url) => `Full article text for ${url} with enough words to be useful.`,
    // The model is asked twice (plan + synthesize); branch on the prompt.
    complete: async (_system, user) => {
      if (user.startsWith('Return a JSON array')) {
        return '["query one", "query two"]';
      }
      // Synthesis: cite the first source id that appears in the prompt, plus a bogus one.
      const id = user.match(/id="(s[0-9a-f]{8})"/)?.[1] ?? 'sUNKNOWN';
      return JSON.stringify({
        sections: [
          { heading: 'Answer', markdown: 'The key finding.', citations: [id, 'sBADBEEF'] },
          { heading: 'Aside', markdown: 'An unsupported aside.', citations: [] },
        ],
        limitations: 'Limited sample.',
      });
    },
    ...over,
  };
}

describe('runResearch', () => {
  test('produces a cited report; dangling citations dropped, uncited flagged', async () => {
    const stages: string[] = [];
    const report = await runResearch('Does X cause Y?', 'standard', fakeDeps(), (s) => stages.push(s));

    expect(report.question).toBe('Does X cause Y?');
    expect(report.generatedAt).toBe(NOW);
    expect(report.sources.length).toBeGreaterThan(0);

    const answer = report.sections.find((s) => s.heading === 'Answer')!;
    expect(answer.citations).toHaveLength(1); // the bogus citation was removed
    expect(report.sources.map((s) => s.id)).toContain(answer.citations[0]);

    expect(report.limitations).toContain('Limited sample');
    expect(report.limitations).toMatch(/unknown sources were removed|could not be tied/);
    expect(stages).toContain('synthesizing');
    expect(stages).toContain('done');
  });

  test('fails loud when no sources can be gathered', async () => {
    const deps = fakeDeps({ search: async () => [], fetchText: async () => '' });
    await expect(runResearch('Unanswerable?', 'quick', deps)).rejects.toThrow(/No sources/);
  });

  test('falls back to a single section when synthesis is not valid JSON', async () => {
    const deps = fakeDeps({ complete: async (_s, user) => (user.startsWith('Return a JSON array') ? '["q"]' : 'plain prose, not json') });
    const report = await runResearch('Q?', 'quick', deps);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0].markdown).toContain('plain prose');
  });

  test('respects depth budget (quick = 1 query, capped sources)', async () => {
    let searches = 0;
    const deps = fakeDeps({
      search: async (q) => {
        searches++;
        return [{ title: 't', url: `https://x.example/${q}/${searches}`, snippet: 's' }];
      },
    });
    await runResearch('Q?', 'quick', deps);
    expect(searches).toBe(1); // quick depth plans a single query
  });

  test("injects today's date into the planning and synthesis prompts", async () => {
    const systems: string[] = [];
    const deps = fakeDeps({
      complete: async (system, user) => {
        systems.push(system);
        if (user.startsWith('Return a JSON array')) return '["q1", "q2"]';
        const id = user.match(/id="(s[0-9a-f]{8})"/)?.[1] ?? 'sUNKNOWN';
        return JSON.stringify({ sections: [{ heading: 'A', markdown: 'x', citations: [id] }], limitations: '' });
      },
    });
    // standard depth = 2 queries, so planning calls the model too (not just synthesis).
    await runResearch('What happened today?', 'standard', deps);
    // NOW is 2026; without the date injection the model would assume its training cutoff.
    expect(systems.length).toBeGreaterThanOrEqual(2);
    expect(systems.every((s) => s.includes('2026'))).toBe(true);
    expect(systems.some((s) => s.includes('June'))).toBe(true);
  });
});
