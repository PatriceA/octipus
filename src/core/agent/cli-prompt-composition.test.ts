import { expect, test } from 'vitest';
import { measureCliPayload } from './cli-prompt-composition';
test('known CLI input includes selected skills, instructions, tools and replay; hidden context is not invented', () => {
  const p = measureCliPayload({
    system: 'ROLE\nSKILL\nEXTRA',
    prompt: 'previous message\nnew message',
    tools: [],
    role: 'general',
    model: 'chosen',
    resumed: true,
    staged: {
      role: 'general',
      model: 'cli/codex',
      parts: [
        { category: 'role', tier: 'static', label: 'Role', text: 'ROLE' },
        { category: 'skills', tier: 'static', label: 'Loaded skill', text: 'SKILL' },
        { category: 'turn', tier: 'volatile', label: 'Not actually sent', text: 'OMITTED' },
      ],
    },
  });
  expect(p.source).toBe('cli-payload');
  expect(p.resumed).toBe(true);
  expect(p.model).toBe('chosen');
  expect(p.sections.find((s) => s.category === 'skills')).toMatchObject({ chars: 5, tokens: 2, text: 'SKILL' });
  expect(p.sections.some((s) => s.label === 'Not actually sent')).toBe(false);
  expect(p.sections.find((s) => s.label === 'New input to resumed CLI')).toMatchObject({
    text: 'previous message\nnew message',
  });
  expect(p.totals.tokens).toBe(p.sections.reduce((n, s) => n + s.tokens, 0));
});
