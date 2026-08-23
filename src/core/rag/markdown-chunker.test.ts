import { describe, expect, test } from 'vitest';
import { chunkMarkdown, looksLikeMarkdown } from './markdown-chunker';

describe('chunkMarkdown', () => {
  test('glues each heading onto its own body, threads parent links', () => {
    const md = `# Title\n\nIntro paragraph.\n\n## Section A\n\nBody of A.\n\n## Section B\n\nBody of B.\n`;
    const chunks = chunkMarkdown(md);
    // 3 sections, each heading folded into its body = 3 chunks (no orphans).
    expect(chunks.length).toBe(3);

    // Title section — heading + its intro body, no parent.
    expect(chunks[0].headingLevel).toBe(1);
    expect(chunks[0].sectionPath).toEqual(['Title']);
    expect(chunks[0].parentIndex).toBeNull();
    expect(chunks[0].content).toBe('# Title\n\nIntro paragraph.');

    // Section A — heading + body, under Title.
    expect(chunks[1].headingLevel).toBe(2);
    expect(chunks[1].sectionPath).toEqual(['Title', 'Section A']);
    expect(chunks[1].parentIndex).toBe(0);
    expect(chunks[1].content).toBe('## Section A\n\nBody of A.');

    // Section B — sibling to A, NOT child of A.
    expect(chunks[2].headingLevel).toBe(2);
    expect(chunks[2].sectionPath).toEqual(['Title', 'Section B']);
    expect(chunks[2].parentIndex).toBe(0);
  });

  test('heading-only sections (no direct body) emit no chunk', () => {
    // A and B have no body of their own — only C carries text.
    const md = `# A\n\n## B\n\n### C\n\nbody`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(1);
    const only = chunks[0];
    expect(only.headingLevel).toBe(3);
    expect(only.sectionPath).toEqual(['A', 'B', 'C']);
    // Title text of the empty ancestors survives via sectionPath + content.
    expect(only.content).toBe('### C\n\nbody');
  });

  test('heading-only intermediate section: leaf parents to nearest emitted ancestor', () => {
    // B has no body of its own, so C must skip past it to A (index 0).
    const md = `# A\n\nbody-a\n\n## B\n\n### C\n\nbody-c`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(2);
    expect(chunks[0].sectionPath).toEqual(['A']);
    expect(chunks[0].parentIndex).toBeNull();
    expect(chunks[1].sectionPath).toEqual(['A', 'B', 'C']);
    expect(chunks[1].parentIndex).toBe(0);
  });

  test('sibling re-entry: H1 → H2 → H1 pops back to root for the new H1', () => {
    const md = `# A\n\n## A.1\n\n# B\n\nbody-under-B`;
    const chunks = chunkMarkdown(md);
    const bUnder = chunks.find((c) => c.content.includes('body-under-B'));
    expect(bUnder).toBeDefined();
    expect(bUnder!.sectionPath).toEqual(['B']);
    expect(bUnder!.content).toBe('# B\n\nbody-under-B');
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
