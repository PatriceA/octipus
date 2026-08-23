import { describe, expect, test } from 'vitest';
import { sectionLabel, summarizePromptSections } from './prompt-budget';

describe('sectionLabel', () => {
  test('derives a name from a markdown heading', () => {
    expect(sectionLabel('\n\n# Topic Skills\nsome body text')).toBe('Topic Skills');
  });

  test('derives a name from an ALL-CAPS lead-in', () => {
    expect(sectionLabel('\n\nPRODUCT DOCS: the docs are indexed')).toBe('PRODUCT DOCS: the docs are indexed');
  });

  test('strips rule markers used by the AGENTS.md block', () => {
    expect(sectionLabel('\n\n--- AGENTS.md (octipus) ---\nbody')).toBe('AGENTS.md (octipus) ---');
  });

  test('caps the label so a section with no heading cannot flood the log', () => {
    expect(sectionLabel('x'.repeat(500)).length).toBe(48);
  });

  test('handles an all-whitespace section', () => {
    expect(sectionLabel('   \n  \n')).toBe('(empty)');
  });
});

describe('summarizePromptSections', () => {
  test('ranks sections by size and attributes them to their tier', () => {
    const { total, sections } = summarizePromptSections({
      static: ['# Role\nshort', `# Skills\n${'x'.repeat(1000)}`],
      volatile: ['CURRENT DATE/TIME: now'],
    });

    expect(sections[0].label).toBe('static:Skills');
    expect(sections[0].share).toBeGreaterThan(0.9);
    expect(sections.map((s) => s.label)).toContain('volatile:CURRENT DATE/TIME: now');
    expect(total.chars).toBe(sections.reduce((n, s) => n + s.chars, 0));
    expect(total.tokens).toBe(Math.ceil(total.chars / 4));
  });

  test('drops empty parts rather than logging blank rows', () => {
    const { sections } = summarizePromptSections({ static: ['# A\nbody', '', undefined as unknown as string] });
    expect(sections).toHaveLength(1);
  });

  test('an empty assembly does not divide by zero', () => {
    const { total, sections } = summarizePromptSections({ static: [], volatile: [] });
    expect(total).toEqual({ chars: 0, tokens: 0 });
    expect(sections).toEqual([]);
  });
});
