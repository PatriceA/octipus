/**
 * A small block parser for the markdown an agent writes.
 *
 * The repo has no markdown library and does not want one for this: the export
 * path needs headings, emphasis, lists, tables, quotes, code and rules — the
 * subset a model actually emits in a deliverable — and nothing about
 * reference links or HTML passthrough. Keeping it here means the docx writer
 * and the xlsx writer read the same structure, so a table exports identically
 * whichever format the user asked for.
 */

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type MarkdownBlock =
  | { kind: 'heading'; level: number; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'quote'; runs: InlineRun[] }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'list'; ordered: boolean; items: { level: number; runs: InlineRun[] }[] }
  | { kind: 'table'; caption?: string; header: InlineRun[][]; rows: InlineRun[][][] }
  | { kind: 'rule' };

/**
 * Split one line into styled runs.
 *
 * Code spans are taken first and never re-scanned, so `` `**a**` `` stays
 * literal. A link keeps its text; the URL is appended in parentheses when it
 * says something the text does not, because a printed document cannot be
 * clicked and dropping the destination silently loses the citation.
 */
export function parseInline(line: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const push = (text: string, style: Omit<InlineRun, 'text'>) => {
    if (text.length === 0) return;
    const last = runs[runs.length - 1];
    if (last && !!last.bold === !!style.bold && !!last.italic === !!style.italic && !!last.code === !!style.code) {
      last.text += text;
      return;
    }
    runs.push({ text, ...style });
  };

  // Links first: the label may itself contain emphasis, so it is re-fed
  // through this function by the walk below rather than being taken literally.
  const flattened = line.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_all, label: string, url: string) => {
      const text = label.trim();
      if (text.length === 0) return url;
      if (text === url) return text;
      return `${text} (${url})`;
    },
  );

  const token = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_/g;
  let index = 0;
  let match = token.exec(flattened);
  while (match !== null) {
    push(flattened.slice(index, match.index), {});
    if (match[2] !== undefined) push(match[2], { code: true });
    else if (match[3] !== undefined) push(match[3], { bold: true });
    else if (match[4] !== undefined) push(match[4], { bold: true });
    else if (match[5] !== undefined) push(match[5], { italic: true });
    else if (match[6] !== undefined) push(match[6], { italic: true });
    index = match.index + match[0].length;
    match = token.exec(flattened);
  }
  push(flattened.slice(index), {});

  return runs.length > 0 ? runs : [{ text: '' }];
}

/** Split a markdown table row into cells, honouring escaped pipes. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') { current += '|'; i++; continue; }
    if (ch === '|') { cells.push(current); current = ''; continue; }
    current += ch;
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

const DELIMITER_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function isTableStart(lines: string[], i: number): boolean {
  return (
    lines[i].includes('|') &&
    i + 1 < lines.length &&
    lines[i + 1].includes('-') &&
    DELIMITER_ROW.test(lines[i + 1])
  );
}

/**
 * Parse markdown into blocks.
 *
 * `caption` on a table is the nearest preceding heading, which is what names
 * the sheet when the same document is exported to a spreadsheet.
 */
export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let lastHeading: string | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().length === 0) { i++; continue; }

    const fence = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence, or end of input
      const block: MarkdownBlock = { kind: 'code', text: body.join('\n') };
      if (fence[2]) block.language = fence[2];
      blocks.push(block);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].replace(/\s+#+\s*$/, '').trim();
      lastHeading = text;
      blocks.push({ kind: 'heading', level: heading[1].length, runs: parseInline(text) });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(lines[i]).map(parseInline);
      i += 2;
      const rows: InlineRun[][][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().length > 0) {
        const cells = splitRow(lines[i]).map(parseInline);
        // Pad or trim to the header width so the table is rectangular; a
        // ragged row would otherwise produce a malformed docx table.
        while (cells.length < header.length) cells.push(parseInline(''));
        rows.push(cells.slice(0, header.length));
        i++;
      }
      const table: MarkdownBlock = { kind: 'table', header, rows };
      if (lastHeading) table.caption = lastHeading;
      blocks.push(table);
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const items: { level: number; runs: InlineRun[] }[] = [];
      while (i < lines.length) {
        const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!item) break;
        if (/\d/.test(item[2]) !== ordered) break;
        // Two spaces per level is the common convention; four also works.
        const level = Math.min(Math.floor(item[1].replace(/\t/g, '  ').length / 2), 4);
        items.push({ level, runs: parseInline(item[3]) });
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        parts.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', runs: parseInline(parts.join(' ').trim()) });
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const parts: string[] = [];
    while (i < lines.length && lines[i].trim().length > 0) {
      if (/^(#{1,6})\s+/.test(lines[i])) break;
      if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) break;
      if (/^\s*>\s?/.test(lines[i])) break;
      if (/^\s*(```+|~~~+)/.test(lines[i])) break;
      if (isTableStart(lines, i)) break;
      parts.push(lines[i].trim());
      i++;
    }
    if (parts.length > 0) blocks.push({ kind: 'paragraph', runs: parseInline(parts.join(' ')) });
  }

  return blocks;
}

/** Flatten runs back to plain text — used for spreadsheet cells and titles. */
export function runsToText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join('');
}
