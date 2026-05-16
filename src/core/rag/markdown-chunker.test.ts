import { describe, test, expect } from 'bun:test';
import { chunkMarkdown, looksLikeMarkdown } from './markdown-chunker';

describe('chunkMarkdown', () => {
  test('emits one chunk per heading + body, threads parent links', () => {
    const md = `# Title\n\nIntro paragraph.\n\n## Section A\n\nBody of A.\n\n## Section B\n\nBody of B.\n`;
    const chunks = chunkMarkdown(md);
    // 3 headings + 3 body chunks = 6
    expect(chunks.length).toBe(6);

    // Title at index 0 — no parent.
    expect(chunks[0].headingLevel).toBe(1);
    expect(chunks[0].sectionPath).toEqual(['Title']);
    expect(chunks[0].parentIndex).toBeNull();

    // Intro body under Title.
    expect(chunks[1].headingLevel).toBe(0);
    expect(chunks[1].parentIndex).toBe(0);
    expect(chunks[1].sectionPath).toEqual(['Title']);

    // Section A heading under Title.
    expect(chunks[2].headingLevel).toBe(2);
    expect(chunks[2].sectionPath).toEqual(['Title', 'Section A']);
    expect(chunks[2].parentIndex).toBe(0);

    // Body of A under Section A.
    expect(chunks[3].headingLevel).toBe(0);
    expect(chunks[3].parentIndex).toBe(2);

    // Section B heading under Title (sibling to A, NOT child of A).
    expect(chunks[4].headingLevel).toBe(2);
    expect(chunks[4].sectionPath).toEqual(['Title', 'Section B']);
    expect(chunks[4].parentIndex).toBe(0);
  });

  test('deep nesting: H1 → H2 → H3 emits a section path of length 3', () => {
    const md = `# A\n\n## B\n\n### C\n\nbody`;
    const chunks = chunkMarkdown(md);
    const body = chunks[chunks.length - 1];
    expect(body.headingLevel).toBe(0);
    expect(body.sectionPath).toEqual(['A', 'B', 'C']);
  });

  test('sibling re-entry: H1 → H2 → H1 pops back to root for the new H1', () => {
    const md = `# A\n\n## A.1\n\n# B\n\nbody-under-B`;
    const chunks = chunkMarkdown(md);
    const bUnder = chunks.find((c) => c.content === 'body-under-B');
    expect(bUnder).toBeDefined();
    expect(bUnder!.sectionPath).toEqual(['B']);
  });

  test('does not split inside a fenced code block', () => {
    const md = `# Heading\n\n\`\`\`ts\nconst x = 1;\nconst y = 2;\n\`\`\`\n`;
    const chunks = chunkMarkdown(md);
    const fenceChunk = chunks.find((c) => c.content.includes('```ts'));
    expect(fenceChunk).toBeDefined();
    expect(fenceChunk!.content).toContain('const x = 1;');
    expect(fenceChunk!.content).toContain('const y = 2;');
  });

  test('empty document returns []', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n\n')).toEqual([]);
  });

  test('no headings: returns single body chunk under root', () => {
    const md = 'just some prose with no headings at all';
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0].headingLevel).toBe(0);
    expect(chunks[0].sectionPath).toEqual([]);
    expect(chunks[0].parentIndex).toBeNull();
  });
});

describe('looksLikeMarkdown', () => {
  test('matches .md / .markdown / .mdx file paths', () => {
    expect(looksLikeMarkdown('any', 'x.md')).toBe(true);
    expect(looksLikeMarkdown('any', 'README.MARKDOWN')).toBe(true);
    expect(looksLikeMarkdown('any', 'docs/foo.mdx')).toBe(true);
  });

  test('sniffs ATX headings when no file path is given', () => {
    expect(looksLikeMarkdown('# Hello')).toBe(true);
    expect(looksLikeMarkdown('paragraph\n\n## Section')).toBe(true);
    expect(looksLikeMarkdown('plain text with no headings')).toBe(false);
  });

  test('does not match #hashtags or # without following text', () => {
    expect(looksLikeMarkdown('look at #tag in this line')).toBe(false);
    expect(looksLikeMarkdown('#')).toBe(false);
    expect(looksLikeMarkdown('##')).toBe(false);
  });
});
