/**
 * Pure ReportDoc → HTML renderer (feature #5). Produces a self-contained,
 * escaped HTML report with inline numbered citations linking to a Sources
 * list. All text is HTML-escaped — no script or raw markup can pass through —
 * so the output is safe to host via the artifacts renderer.
 */
import type { ReportDoc } from './types';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Minimal markdown → escaped HTML: paragraphs, bullet lists, bold/italic. */
function renderMarkdown(md: string): string {
  const blocks = md.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
      if (isList) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${inline(block.replace(/\n/g, ' '))}</p>`;
    })
    .join('\n');
}

/** Inline emphasis on already-escaped text. */
function inline(text: string): string {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+?)\*/g, '$1<em>$2</em>');
}

export function renderReportHtml(report: ReportDoc): string {
  const orderById = new Map(report.sources.map((s, i) => [s.id, i + 1]));

  const sections = report.sections
    .map((sec) => {
      const marks = sec.citations
        .map((id) => orderById.get(id))
        .filter((n): n is number => n !== undefined)
        .map((n) => `<sup class="cite"><a href="#src-${n}">[${n}]</a></sup>`)
        .join('');
      return `<section><h2>${esc(sec.heading)}</h2>${renderMarkdown(sec.markdown)}${marks ? `<p class="cites">${marks}</p>` : ''}</section>`;
    })
    .join('\n');

  const sources = report.sources
    .map((s, i) => `<li id="src-${i + 1}"><a href="${esc(s.url)}" rel="noopener noreferrer">${esc(s.title)}</a> <span class="src-meta">— retrieved ${esc(s.retrievedAt)}</span></li>`)
    .join('\n');

  return [
    `<article class="research-report">`,
    `<header><h1>${esc(report.question)}</h1>`,
    `<p class="meta">Depth: ${esc(report.depth)} · Generated ${esc(report.generatedAt)} · ${report.sources.length} sources</p></header>`,
    sections,
    `<section class="limitations"><h2>Limitations</h2><p>${esc(report.limitations)}</p></section>`,
    `<section class="sources"><h2>Sources</h2><ol>${sources}</ol></section>`,
    `</article>`,
  ].join('\n');
}
