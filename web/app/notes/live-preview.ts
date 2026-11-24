import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';

// ---------------------------------------------------------------------------
// Live preview for the notes editor: one surface that reads like the rendered
// note and is edited in place (the Obsidian / Typora feel).
//
// The text stays plain markdown (it is what is saved, and what a live space
// note shares through yCollab). Decorations only change how it is drawn:
//   • headings, bold, italic, strikethrough, code, quotes and links are
//     styled, and their markup (`#`, `**`, `[[ ]]`, `](url)`) is hidden on
//     every line except the ones the caret is on, where it can be edited;
//   • `- [ ]` tasks are real checkboxes: a click ticks the task by editing the
//     text, so it saves (or syncs) like typing;
//   • `[[wikilinks]]` and `#tags` are links: a click on a wikilink opens the
//     note (with the markup shown, Ctrl/⌘-click does), Ctrl/⌘-click on a tag
//     filters by it, and Ctrl/⌘-click on a web link opens it.
// ---------------------------------------------------------------------------

/** What clicks on links in the text do. Read through a getter so the editor's extensions stay stable. */
export interface LivePreviewHandlers {
  openWikilink?: (target: string) => void;
  openTag?: (tag: string) => void;
}

/** Mirrors `TAG_RE` in src/core/knowledge/wikilink.ts: `#` after a space or line start, not all digits. */
const TAG_RE = /(^|\s)#([a-zA-Z0-9_/-]*[a-zA-Z_/-][a-zA-Z0-9_/-]*)/g;
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

const hide = Decoration.replace({});
const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, attributes });
const lineClass = (cls: string) => Decoration.line({ class: cls });

/** A drawn `- [ ]`: a checkbox that ticks the task in the text. */
class TaskBox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: TaskBox): boolean {
    return other.checked === this.checked;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-np-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'Mark task not done' : 'Mark task done');
    box.disabled = view.state.readOnly;
    // Keep the caret where it is: a tick is not a move into the line.
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      // The widget stands for the `[ ]` it replaces: one character changes, its inside.
      const pos = view.posAtDOM(wrap);
      const marker = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle-task' });
    });
    wrap.appendChild(box);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** A list's `-` drawn as a bullet. */
class Bullet extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-np-bullet';
    el.textContent = '•';
    return el;
  }
}

const BULLET = Decoration.replace({ widget: new Bullet() });

/** Line numbers the caret (or a selection) is on, while the editor has the focus: their markup shows. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

function inCode(view: EditorView, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
  }
  return false;
}

function build(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const { state } = view;
  const active = activeLines(view);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(lineClass(`cm-np-h cm-np-h${heading[1]}`).range(state.doc.lineAt(node.from).from));
          return;
        }
        switch (name) {
          case 'HeaderMark': {
            if (isActive(node.from)) break;
            // `# ` — the mark and the space after it.
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            if (state.doc.lineAt(node.from).from === node.from) out.push(hide.range(node.from, end));
            break;
          }
          case 'StrongEmphasis':
            out.push(mark('cm-np-strong').range(node.from, node.to));
            break;
          case 'Emphasis':
            out.push(mark('cm-np-em').range(node.from, node.to));
            break;
          case 'Strikethrough':
            out.push(mark('cm-np-strike').range(node.from, node.to));
            break;
          case 'EmphasisMark':
          case 'StrikethroughMark':
            if (!isActive(node.from)) out.push(hide.range(node.from, node.to));
            break;
          case 'InlineCode':
            out.push(mark('cm-np-code').range(node.from, node.to));
            break;
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode' && !isActive(node.from)) out.push(hide.range(node.from, node.to));
            break;
          case 'FencedCode': {
            const first = state.doc.lineAt(node.from).number;
            const last = state.doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) out.push(lineClass('cm-np-codeblock').range(state.doc.line(n).from));
            return false;
          }
          case 'Blockquote': {
            const first = state.doc.lineAt(node.from).number;
            const last = state.doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) out.push(lineClass('cm-np-quote').range(state.doc.line(n).from));
            break;
          }
          case 'QuoteMark': {
            // `> ` reads as the quote's bar (drawn by the line style).
            if (isActive(node.from)) out.push(mark('cm-np-mark').range(node.from, node.to));
            else out.push(hide.range(node.from, state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to));
            break;
          }
          case 'HorizontalRule':
            out.push(lineClass('cm-np-hr').range(state.doc.lineAt(node.from).from));
            if (!isActive(node.from)) out.push(mark('cm-np-hr-text').range(node.from, node.to));
            break;
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            out.push(mark('cm-np-link', url ? { 'data-href': state.sliceDoc(url.from, url.to) } : undefined).range(node.from, node.to));
            if (!isActive(node.from) && marks.length >= 2) {
              out.push(hide.range(marks[0].from, marks[0].to));
              out.push(hide.range(marks[1].from, node.to));
            }
            return false;
          }
          case 'ListMark': {
            const item = node.node.parent;
            const task = item?.getChild('Task');
            const text = state.sliceDoc(node.from, node.to);
            if (isActive(node.from) || !/^[-*+]$/.test(text)) break;
            // A task's bullet gives way to its checkbox; a plain item's is drawn as a dot.
            if (task) out.push(hide.range(node.from, Math.min(node.to + 1, task.from)));
            else out.push(BULLET.range(node.from, node.to));
            break;
          }
          case 'Task': {
            const marker = node.node.getChild('TaskMarker');
            if (!marker) break;
            const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
            out.push(Decoration.replace({ widget: new TaskBox(checked) }).range(marker.from, marker.to));
            out.push(lineClass(checked ? 'cm-np-task cm-np-task-done' : 'cm-np-task').range(state.doc.lineAt(node.from).from));
            break;
          }
          default:
            break;
        }
        return undefined;
      },
    });

    // Wikilinks and tags are not markdown syntax: found per visible line.
    const startLine = state.doc.lineAt(from).number;
    const endLine = state.doc.lineAt(to).number;
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n);
      const lineActive = active.has(n);
      for (const m of line.text.matchAll(WIKILINK_RE)) {
        const start = line.from + (m.index ?? 0);
        if (inCode(view, start)) continue;
        const inner = m[1];
        const pipe = inner.indexOf('|');
        const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split('#')[0].trim();
        const end = start + m[0].length;
        out.push(mark('cm-np-wikilink', { 'data-wikilink': target }).range(start, end));
        if (!lineActive) {
          out.push(hide.range(start, start + 2 + (pipe >= 0 ? pipe + 1 : 0)));
          out.push(hide.range(end - 2, end));
        }
      }
      for (const m of line.text.matchAll(TAG_RE)) {
        const start = line.from + (m.index ?? 0) + m[1].length;
        // A heading's `#` is followed by a space and never matches; skip code.
        if (inCode(view, start)) continue;
        out.push(mark('cm-np-tag', { 'data-tag': m[2] }).range(start, start + m[2].length + 1));
      }
    }
  }
  return Decoration.set(out, true);
}

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Clicks on the drawn links. */
function clicks(handlers: () => LivePreviewHandlers) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const el = event.target instanceof Element ? event.target : null;
      if (!el || event.button !== 0) return false;
      const mod = event.metaKey || event.ctrlKey;
      const wiki = el.closest<HTMLElement>('[data-wikilink]');
      if (wiki) {
        const pos = view.posAtDOM(wiki);
        // With the markup hidden a click opens the note; with it shown, only Ctrl/⌘-click does.
        const shown = view.hasFocus && view.state.selection.ranges.some((r) => view.state.doc.lineAt(r.head).number === view.state.doc.lineAt(pos).number);
        const open = handlers().openWikilink;
        if (open && (mod || !shown)) {
          event.preventDefault();
          open(wiki.dataset.wikilink ?? '');
          return true;
        }
        return false;
      }
      if (!mod) return false;
      const tag = el.closest<HTMLElement>('[data-tag]');
      const openTag = handlers().openTag;
      if (tag && openTag) {
        event.preventDefault();
        openTag(tag.dataset.tag ?? '');
        return true;
      }
      const link = el.closest<HTMLElement>('[data-href]');
      const href = link?.dataset.href;
      if (href && /^https?:\/\//i.test(href)) {
        event.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
        return true;
      }
      return false;
    },
  });
}

/** Colours for what the decorations leave alone (code in fences, marks shown on the caret's line). */
const highlight = HighlightStyle.define([
  { tag: tags.processingInstruction, color: 'var(--color-outline)' },
  { tag: tags.meta, color: 'var(--color-outline)' },
  { tag: tags.url, color: 'var(--color-on-surface-variant)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)' },
  { tag: [tags.keyword, tags.operator], color: 'var(--color-secondary)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-tertiary)' },
  { tag: [tags.number, tags.bool, tags.atom], color: 'var(--color-accent)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--color-on-surface-variant)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className], color: 'var(--color-primary)' },
]);

/** The live-preview extension set: decorations, link clicks and the paper colours. */
export function livePreview(handlers: () => LivePreviewHandlers) {
  return [decorations, clicks(handlers), syntaxHighlighting(highlight)];
}
