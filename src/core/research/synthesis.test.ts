import { describe, expect, test } from 'bun:test';
import { renderReportHtml } from './render';
import { buildSource, resolveReport } from './synthesis';
import type { Source } from './types';

function sources(): Source[] {
  return [
    buildSource('https://a.example/x', 'Source A', 'content a', '2026-06-01T00:00:00Z'),
    buildSource('https://b.example/y', 'Source B', 'content b', '2026-06-01T00:00:00Z'),
  ];
}

describe('buildSource', () => {
  test('stable id from url, content hash present', () => {
    const s1 = buildSource('https://a.example/x', 'A', 'hello', '2026-06-01T00:00:00Z');
    const s2 = buildSource('https://a.example/x', 'A different title', 'other', '2026-06-02T00:00:00Z');
    expect(s1.id).toBe(s2.id); // id derives from url only → stable
    expect(s1.hash).not.toBe(s2.hash); // hash reflects content
    expect(s1.id).toMatch(/^s[0-9a-f]{8}$/);
  });
});

describe('resolveReport — citation integrity', () => {
  test('drops citations that do not resolve to a gathered source', () => {
    const src = sources();
    const report = resolveReport({
      question: 'Q?',
      depth: 'standard',
      generatedAt: '2026-06-03T00:00:00Z',
      sources: src,
      rawSections: [
        { heading: 'Finding', markdown: 'A real claim.', citations: [src[0].id, 'sDEADBEEF', 'sfake1234'] },
      ],
    });
    expect(report.sections[0].citations).toEqual([src[0].id]);
    expect(report.limitations).toContain('citation(s) referencing unknown sources were removed');
  });

  test('flags sections with no valid citation in limitations', () => {
    const src = sources();
    const report = resolveReport({
      question: 'Q?',
      depth: 'quick',
      generatedAt: '2026-06-03T00:00:00Z',
      sources: src,
      rawSections: [
        { heading: 'Cited', markdown: 'Backed claim.', citations: [src[0].id] },
        { heading: 'Uncited', markdown: 'Floating claim.', citations: [] },
      ],
    });
    expect(report.sections).toHaveLength(2);
    expect(report.limitations).toContain('could not be tied to a specific source');
  });

  test('drops empty sections and prunes uncited sources', () => {
    const src = sources(); // A and B
    const report = resolveReport({
      question: 'Q?',
      depth: 'standard',
      generatedAt: '2026-06-03T00:00:00Z',
      sources: src,
      rawSections: [
        { heading: 'Real', markdown: 'Cites A only.', citations: [src[0].id] },
        { heading: 'Empty', markdown: '   ', citations: [src[1].id] },
      ],
    });
    expect(report.sections).toHaveLength(1);
    // B was only cited by the dropped empty section → pruned from bibliography.
    expect(report.sources.map((s) => s.id)).toEqual([src[0].id]);
  });

  test('throws when there are no sources (fail loud, no fabricated report)', () => {
    expect(() =>
      resolveReport({ question: 'Q?', depth: 'quick', generatedAt: 'now', sources: [], rawSections: [] }),
    ).toThrow(/No sources/);
  });
});

describe('renderReportHtml', () => {
  test('renders sections, numbered citations, and a sources list — escaped', () => {
    const src = sources();
    const report = resolveReport({
      question: 'Is <b>X</b> true?',
      depth: 'standard',
      generatedAt: '2026-06-03T00:00:00Z',
      sources: src,
      rawSections: [{ heading: 'Yes', markdown: 'It is **true**.', citations: [src[0].id] }],
    });
    const html = renderReportHtml(report);
    expect(html).toContain('<sup class="cite"><a href="#src-1">[1]</a></sup>');
    expect(html).toContain('id="src-1"');
    expect(html).toContain('<strong>true</strong>');
    // The question's angle brackets are escaped, not rendered as markup.
    expect(html).toContain('Is &lt;b&gt;X&lt;/b&gt; true?');
    expect(html).not.toContain('<b>X</b>');
  });

  test('neutralizes a javascript: source URL in the bibliography', () => {
    const bad = buildSource('javascript:alert(1)', 'Evil Source', 'c', '2026-06-03T00:00:00Z');
    const report = resolveReport({
      question: 'Q?',
      depth: 'quick',
      generatedAt: '2026-06-03T00:00:00Z',
      sources: [bad],
      rawSections: [{ heading: 'A', markdown: 'claim', citations: [bad.id] }],
    });
    const html = renderReportHtml(report);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"'); // dangerous scheme replaced
  });
});
