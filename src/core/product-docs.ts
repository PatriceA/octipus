/** Bundled product help, searched locally only when requested. No DB, models or startup work. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { octipusRoot } from '@/utils/install-root';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 400;
const CACHE_MS = 60_000;
const STOP = new Set('a an and are as at be by can do does for from how i in is it me my of on or our the this to use we what when where which with you your'.split(' '));
const ALIASES: Record<string, string> = { configure: 'setup', configuration: 'setup', configuring: 'setup', install: 'install', installation: 'install', connect: 'connect', connection: 'connect', connecting: 'connect' };
const words = (text: string) => (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
  .map(w => w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
  .map(w => Object.hasOwn(ALIASES, w) ? ALIASES[w] : w);

interface Section { heading: string; line: number; end: number; terms: Map<string, number> }
interface Document { file: string; title: string; lines: string[]; sections: Section[] }
export interface ProductDocHit { file: string; title: string; heading: string; line: number; excerpt: string }

/** The optional root is a server/test seam, never a tool argument. */
export class ProductDocs {
  private cache: { expires: number; documents: Document[] } | null = null;
  private loading: Promise<Document[]> | null = null;
  constructor(private readonly root?: string) {}

  private directory(): string { return this.root ?? join(octipusRoot(), 'docs'); }

  private async load(): Promise<Document[]> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.documents;
    if (this.loading) return this.loading;
    this.loading = this.scan();
    try {
      const documents = await this.loading;
      this.cache = { expires: Date.now() + CACHE_MS, documents };
      return documents;
    } finally { this.loading = null; }
  }

  private async scan(): Promise<Document[]> {
    const root = this.directory();
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The bundled documentation directory is missing or is a symbolic link.');
    const files: string[] = [];
    const walk = async (dir: string, prefix = ''): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if ((!prefix && ['architecture', 'guides'].includes(entry.name)) || (prefix && entry.name !== 'generated')) await walk(join(dir, entry.name), file);
        } else if (entry.isFile() && /\.md$/i.test(file) && !/changelog/i.test(file) && file.toLowerCase() !== 'qa.md') files.push(file);
        if (files.length > MAX_FILES) throw new Error('Bundled documentation exceeds the local search file limit.');
      }
    };
    await walk(root);
    let bytes = 0;
    const documents: Document[] = [];
    for (const file of files) {
      const path = join(root, file);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Bundled documentation changed during search: ${file}`);
      if (info.size > MAX_FILE_BYTES || (bytes += info.size) > MAX_TOTAL_BYTES) throw new Error('Bundled documentation exceeds the local search size limit.');
      const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
      const title = lines.find(l => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() ?? file;
      const sections: Section[] = [];
      let heading = title; let start = 0; let fence = '';
      const ancestors: Array<{ level: number; text: string }> = [];
      const add = (end: number) => {
        if (end <= start) return;
        const terms = new Map<string, number>();
        for (const word of words(lines.slice(start, end).join('\n'))) terms.set(word, (terms.get(word) ?? 0) + 1);
        sections.push({ heading, line: start + 1, end, terms });
      };
      lines.forEach((line, i) => {
        const mark = line.trimStart().match(/^(```+|~~~+)/)?.[1];
        if (mark) { if (!fence) fence = mark[0]; else if (fence === mark[0]) fence = ''; return; }
        const match = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
        if (match) {
          add(i);
          while (ancestors.length && ancestors[ancestors.length - 1].level >= match[1].length) ancestors.pop();
          ancestors.push({ level: match[1].length, text: match[2] });
          heading = ancestors.filter(a => a.level > 1).map(a => a.text).join(' › ') || match[2];
          start = i;
        }
      });
      add(lines.length);
      documents.push({ file, title, lines, sections });
    }
    return documents;
  }

  async search(query: string, limit = 5): Promise<ProductDocHit[]> {
    if (!query.trim() || query.length > 500) throw new Error('Use a documentation query between 1 and 500 characters.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Documentation result limit must be between 1 and 10.');
    const tokens = [...new Set(words(query).filter(w => !STOP.has(w)))];
    if (!tokens.length) return [];
    const ranked: Array<ProductDocHit & { score: number }> = [];
    const documents = await this.load();
    const allSections = documents.flatMap(doc => doc.sections);
    const idf = new Map(tokens.map(token => [token, Math.log(1 + allSections.length / (1 + allSections.filter(section => section.terms.has(token)).length))]));
    for (const doc of documents) {
      const title = new Set(words(doc.title)); const path = new Set(words(doc.file));
      for (const section of doc.sections) {
        const heading = new Set(words(section.heading));
        let score = 0; let matched = 0;
        for (const token of tokens) {
          const count = section.terms.get(token) ?? 0;
          if (count || heading.has(token) || title.has(token) || path.has(token)) matched++;
          score += (idf.get(token) ?? 1) * (Math.min(count, 3) + (heading.has(token) ? 6 : 0) + (title.has(token) ? 3 : 0) + (path.has(token) ? 2 : 0));
        }
        if (!matched) continue;
        const offset = doc.lines.slice(section.line - 1, section.end).findIndex(line => words(line).some(w => tokens.includes(w)));
        const matchLine = offset < 0 ? -1 : section.line - 1 + offset;
        const from = Math.max(section.line - 1, matchLine < 0 ? section.line - 1 : matchLine - 2);
        ranked.push({ file: doc.file, title: doc.title, heading: section.heading, line: from + 1,
          excerpt: doc.lines.slice(from, Math.min(section.end, from + 12)).join('\n').slice(0, 1800),
          score: score + matched * 10 });
      }
    }
    const perFile = new Map<string, number>();
    return ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line)
      .filter(hit => { const n = perFile.get(hit.file) ?? 0; perFile.set(hit.file, n + 1); return n < 2; })
      .slice(0, limit).map(({ score: _score, ...hit }) => hit);
  }

  async read(file: string, line = 1, maxLines = 60): Promise<{ file: string; line: number; totalLines: number; content: string; truncated: boolean }> {
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > 120) throw new Error('Use a positive start line and 1–120 lines.');
    const normalized = file.replaceAll('\\', '/');
    const doc = (await this.load()).find(d => d.file === normalized);
    if (!doc || isAbsolute(normalized) || relative(resolve(this.directory()), resolve(this.directory(), normalized)).startsWith('..')) throw new Error('Choose a bundled documentation file returned by search_product_docs.');
    const end = Math.min(doc.lines.length, line - 1 + maxLines);
    const text = doc.lines.slice(line - 1, end).map((text, i) => `${line + i}: ${text}`).join('\n');
    return { file: doc.file, line, totalLines: doc.lines.length, content: text.slice(0, 24_000), truncated: end < doc.lines.length || text.length > 24_000 };
  }
}

export const productDocs = new ProductDocs();
