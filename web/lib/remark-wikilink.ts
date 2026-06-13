// remark (mdast) plugin: render `[[wikilinks]]` and inline `#tags` in the notes
// preview. Each is turned into a `link` node with a custom protocol —
// `wikilink:<slug>` / `tag:<name>` — which the Markdown component's `a` renderer
// maps to in-app actions (open note / filter by tag). Dependency-free (a manual
// tree walk, no unist-util-visit) and only applied when the notes preview opts
// in, so chat/docs rendering is untouched.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** Mirror of slugify() in src/core/knowledge/wikilink.ts (path-preserving). */
function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9/_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '');
}

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
// A tag: `#` at a word boundary, with at least one non-digit (so `#123` issue
// refs are not tags — mirrors TAG_RE in wikilink.ts).
const TAG_RE = /(^|[\s(])(#[A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;

function linkNode(url: string, text: string): MdNode {
  return { type: 'link', url, children: [{ type: 'text', value: text }] };
}

/** Split a plain string into text + `tag:` link nodes. */
function splitTags(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  const re = new RegExp(TAG_RE.source, 'g');
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(value))) {
    const boundary = m[1] ?? '';
    const tag = m[2];
    const tagStart = m.index + boundary.length;
    if (tagStart > last) out.push({ type: 'text', value: value.slice(last, tagStart) });
    out.push(linkNode(`tag:${tag.slice(1).toLowerCase()}`, tag));
    last = tagStart + tag.length;
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out.length ? out : [{ type: 'text', value }];
}

/** Split a plain string into text + `wikilink:`/`tag:` link nodes. */
function splitInline(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  const re = new RegExp(WIKILINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(value))) {
    if (m.index > last) out.push(...splitTags(value.slice(last, m.index)));
    let rest = m[1];
    let alias: string | undefined;
    const pipe = rest.indexOf('|');
    if (pipe !== -1) {
      alias = rest.slice(pipe + 1).trim();
      rest = rest.slice(0, pipe);
    }
    const hash = rest.indexOf('#');
    if (hash !== -1) rest = rest.slice(0, hash);
    const target = rest.trim();
    const ref = slugify(target);
    if (ref) out.push(linkNode(`wikilink:${ref}`, alias || target));
    else out.push({ type: 'text', value: m[0] }); // empty target → leave literal
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push(...splitTags(value.slice(last)));
  return out.length ? out : [{ type: 'text', value }];
}

function walk(node: MdNode): void {
  // Don't rewrite inside links or code — a `#` in a URL or code sample isn't a tag.
  if (node.type === 'link' || node.type === 'linkReference' || node.type === 'code' || node.type === 'inlineCode') return;
  if (!node.children) return;
  const next: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string' && (child.value.includes('[[') || child.value.includes('#'))) {
      const pieces = splitInline(child.value);
      if (pieces.length > 1 || pieces[0].type !== 'text') {
        changed = true;
        next.push(...pieces);
      } else {
        next.push(child);
      }
    } else {
      walk(child);
      next.push(child);
    }
  }
  if (changed) node.children = next;
}

export function remarkWikilink() {
  return (tree: MdNode): void => walk(tree);
}
