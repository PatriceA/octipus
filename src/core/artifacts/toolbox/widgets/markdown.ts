/**
 * art_widget_markdown — tiny safe-subset markdown → HTML. Supports headings,
 * paragraphs, bold/italic, inline code, fenced code blocks, links, bullet
 * lists. Anything else is escaped. No external dependency.
 */

import type { ToolboxTool } from '../types';
import { asString, escapeHtml, type WidgetRender } from './_shared';

interface Params {
  text: unknown;
}

export const markdownWidget: ToolboxTool<Params, WidgetRender> = {
  id: 'art_widget_markdown',
  family: 'widget',
  description: 'Safe-subset markdown block (headings, paragraphs, lists, code, links, bold/italic).',
  keywords: ['markdown', 'md', 'text', 'prose', 'block'],
  defaultPermission: 'ALLOW',
  params: {
    text: { type: 'string', required: true, description: 'Markdown source.' },
  },
  returns: '`{ html, css }` — rendered prose. Unrecognised syntax is escaped, not interpreted.',
  examples: [
    {
      summary: 'Title + bullet list',
      params: { text: '# Today\n\n- one\n- two\n' },
    },
  ],
  tips: ['Use this for static commentary on a dashboard; for live values, bind through the data bus.'],

  async execute(params) {
    return { html: `<div class="aw-md">${renderMarkdown(asString(params.text))}</div>`, css: MD_CSS };
  },
};

function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listBuf: string[] = [];

  const flushList = () => {
    if (listBuf.length) {
      out.push(`<ul>${listBuf.join('')}</ul>`);
      listBuf = [];
    }
  };

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      listBuf.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    flushList();
    if (raw.trim() === '') continue;
    out.push(`<p>${inline(raw)}</p>`);
  }

  flushList();
  if (inCode && codeBuf.length) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}

function inline(raw: string): string {
  let s = escapeHtml(raw);
  // [text](url) — only http(s) and mailto allowed.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
    if (!/^(https?:|mailto:)/i.test(url)) return _;
    return `<a href="${url}">${txt}</a>`;
  });
  // `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // *italic* (single, not greedy)
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

const MD_CSS = `
.aw-md { font: 14px/1.6 system-ui, sans-serif; color: #1f2937; }
.aw-md h1, .aw-md h2, .aw-md h3, .aw-md h4 { margin: 16px 0 8px; line-height: 1.2; }
.aw-md h1 { font-size: 24px; }
.aw-md h2 { font-size: 20px; }
.aw-md h3 { font-size: 17px; }
.aw-md p { margin: 0 0 8px; }
.aw-md ul { padding-left: 20px; margin: 8px 0; }
.aw-md code { background: #f3f4f6; padding: 2px 5px; border-radius: 3px; font-size: 13px; font-family: ui-monospace, monospace; }
.aw-md pre { background: #1f2937; color: #e5e7eb; padding: 12px; border-radius: 6px; overflow-x: auto; }
.aw-md pre code { background: none; padding: 0; color: inherit; }
.aw-md a { color: #2563eb; }
`;

export default markdownWidget;
