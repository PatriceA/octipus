import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { type Range, StateEffect } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { api } from '@/lib/api';
import { TODO_MARKER_TAIL } from '../../../src/shared/note-todos';

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
//     filters by it, and Ctrl/⌘-click on a web link opens it;
//   • a task line made a to-do ends in its marker (` ^todo-…`,
//     src/shared/note-todos.ts), drawn as a chip naming the to-do's state
//     that opens it (one step for the caret: the marker cannot be typed
//     into); a task line that is not one yet offers "make a to-do" on hover
//     and on the caret's line.
// ---------------------------------------------------------------------------

/** A to-do as a line's chip shows it. */
export interface TodoChipView {
  title: string;
  status: string;
}

/** What clicks on links in the text do. Read through a getter so the editor's extensions stay stable. */
export interface LivePreviewHandlers {
  openWikilink?: (target: string) => void;
  openTag?: (tag: string) => void;
  /** The to-do a line's marker names, as the reader can see it; null when it is not one they can open. */
  todoOf?: (anchor: string) => TodoChipView | null;
  /** A click on a line's to-do chip. */
  openTodo?: (anchor: string) => void;
  /**
   * "Make a to-do" of a line (0-based line number), or of the text selected
   * on it (`selection`). Absent: not offered.
   */
  makeTodo?: (line: number, selection?: string) => void;
  /** The box of a line made a to-do was ticked (or unticked) here. */
  todoToggled?: (anchor: string, checked: boolean) => void;
}

/** Dispatched when what `todoOf` answers changed (a to-do was completed, made, removed): the chips redraw. */
export const todoLinksChanged = StateEffect.define<null>();

/** A task line: list marker, then a box. Its marker (if any) is at the end. */
const TASK_LINE = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/;

/** Mirrors `TAG_RE` in src/core/knowledge/wikilink.ts: `#` after a space or line start, not all digits. */
const TAG_RE = /(^|\s)#([a-zA-Z0-9_/-]*[a-zA-Z_/-][a-zA-Z0-9_/-]*)/g;
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

const hide = Decoration.replace({});
const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, attributes });
const lineClass = (cls: string) => Decoration.line({ class: cls });

/** A drawn `- [ ]`: a checkbox that ticks the task in the text. */
class TaskBox extends WidgetType {
  constructor(readonly checked: boolean, readonly anchor: string | null, readonly handlers: () => LivePreviewHandlers) {
    super();
  }

  override eq(other: TaskBox): boolean {
    return other.checked === this.checked && other.anchor === this.anchor;
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
      if (this.anchor) this.handlers().todoToggled?.(this.anchor, marker[1] === ' ');
    });
    wrap.appendChild(box);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const TODO_STATE: Record<string, string> = { done: 'Done', archived: 'Deleted', in_progress: 'In progress' };

/** A line's marker drawn as the to-do it names: its state, a click opens it. */
class TodoChip extends WidgetType {
  constructor(readonly anchor: string, readonly todo: TodoChipView | null, readonly handlers: () => LivePreviewHandlers) {
    super();
  }

  override eq(other: TodoChip): boolean {
    return other.anchor === this.anchor && other.todo?.status === this.todo?.status && other.todo?.title === this.todo?.title;
  }

  override toDOM(): HTMLElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cm-np-todo';
    chip.dataset.todoAnchor = this.anchor;
    const state = this.todo ? TODO_STATE[this.todo.status] ?? 'To-do' : 'To-do';
    chip.dataset.state = this.todo?.status ?? 'unknown';
    chip.textContent = state;
    chip.title = this.todo ? `Open the to-do “${this.todo.title}”` : 'A to-do (not one you can open here)';
    chip.setAttribute('aria-label', this.todo ? `To-do: ${this.todo.title} (${state.toLowerCase()}). Open it` : 'Linked to-do');
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.todo) this.handlers().openTodo?.(this.anchor);
    });
    return chip;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** "Make a to-do" at the end of a task line that is not one yet. */
class MakeTodo extends WidgetType {
  constructor(readonly line: number, readonly handlers: () => LivePreviewHandlers) {
    super();
  }

  override eq(other: MakeTodo): boolean {
    return other.line === this.line;
  }

  override toDOM(): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-np-make-todo';
    button.textContent = '+ To-do';
    button.title = 'Make this a to-do (⌘⇧Enter)';
    button.setAttribute('aria-label', 'Make this line a to-do');
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      this.handlers().makeTodo?.(this.line);
    });
    return button;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** How long a picture no widget shows any more keeps its object URL (the caret passing its line redraws it). */
const IMAGE_KEEP_MS = 30_000;

/**
 * The object URLs of `/api/…` pictures, one fetch per source however often
 * its widget is drawn: each draw holds a reference (`acquireImage`) and
 * gives it back when CodeMirror destroys that DOM (`releaseImage`); the URL
 * is revoked once nothing has held it for `IMAGE_KEEP_MS`. A failed fetch
 * is forgotten, so the next draw tries again.
 */
const imageUrls = new Map<string, { url: Promise<string>; refs: number; timer: ReturnType<typeof setTimeout> | null }>();

function acquireImage(src: string): Promise<string> {
  let entry = imageUrls.get(src);
  if (!entry) {
    const url = api.getBlob(src.slice('/api'.length)).then((blob) => URL.createObjectURL(blob));
    const made = { url, refs: 0, timer: null as ReturnType<typeof setTimeout> | null };
    url.catch(() => { if (imageUrls.get(src) === made) imageUrls.delete(src); });
    imageUrls.set(src, made);
    entry = made;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.refs++;
  return entry.url;
}

function releaseImage(src: string): void {
  const entry = imageUrls.get(src);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  entry.timer = setTimeout(() => {
    if (imageUrls.get(src) !== entry || entry.refs > 0) return;
    imageUrls.delete(src);
    entry.url.then((url) => URL.revokeObjectURL(url), () => undefined);
  }, IMAGE_KEEP_MS);
}

/**
 * `![alt](src)` drawn as the picture. A `/api/…` source is fetched through
 * the API client (credentials ride along, as `AuthedImage` does for the
 * reading view), once per source (`acquireImage`), and the reference is
 * kept with the DOM the widget drew, given back when CodeMirror destroys
 * that DOM — a URL that arrives after is never set on it. Another source
 * loads as a plain image, as in the reading view.
 */
class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-np-image';
    const img = document.createElement('img');
    img.alt = this.alt;
    img.loading = 'lazy';
    wrap.appendChild(img);
    if (this.src.startsWith('/api/')) {
      wrap.dataset.state = 'loading';
      wrap.dataset.src = this.src;
      acquireImage(this.src).then(
        (url) => {
          // Destroyed meanwhile: the reference was given back; nothing to show.
          if (wrap.dataset.destroyed) return;
          img.src = url;
          wrap.dataset.state = 'ready';
        },
        (err: unknown) => {
          console.warn('A note image could not be loaded', this.src, err);
          if (wrap.dataset.destroyed) return;
          wrap.dataset.state = 'failed';
          wrap.textContent = `image unavailable${this.alt ? ` — ${this.alt}` : ''}`;
        },
      );
    } else if (/^https?:\/\//i.test(this.src)) {
      img.src = this.src;
    } else {
      wrap.textContent = this.alt || this.src;
    }
    return wrap;
  }

  override destroy(dom: HTMLElement): void {
    if (dom.dataset.src && !dom.dataset.destroyed) {
      dom.dataset.destroyed = '1';
      releaseImage(dom.dataset.src);
    }
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

function build(view: EditorView, images: boolean, handlers: () => LivePreviewHandlers): { decorations: DecorationSet; markers: DecorationSet } {
  const out: Range<Decoration>[] = [];
  const markers: Range<Decoration>[] = [];
  const links = handlers();
  const { state } = view;
  const active = activeLines(view);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  // A decoration that replaces text must stay inside one line: a plugin may
  // not replace a line break (CodeMirror throws). Markdown constructs can span
  // lines (a link's `](` on one line and its URL on the next), so every
  // replaced range is checked here and left alone when it would cross one.
  const oneLine = (from: number, to: number) => from < to && state.doc.lineAt(from).number === state.doc.lineAt(to).number;
  const replace = (deco: Decoration, from: number, to: number) => {
    if (oneLine(from, to)) out.push(deco.range(from, to));
  };
  // A mark may span lines, but never be empty.
  const style = (deco: Decoration, from: number, to: number) => {
    if (from < to) out.push(deco.range(from, to));
  };
  // Line styles of a block, for the lines of it that are on screen.
  const blockLines = (cls: string, from: number, to: number, visFrom: number, visTo: number) => {
    const first = state.doc.lineAt(Math.max(from, visFrom)).number;
    const last = state.doc.lineAt(Math.min(to, visTo)).number;
    for (let n = first; n <= last; n++) out.push(lineClass(cls).range(state.doc.line(n).from));
  };

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
            if (state.doc.lineAt(node.from).from === node.from) replace(hide, node.from, end);
            break;
          }
          case 'StrongEmphasis':
            style(mark('cm-np-strong'), node.from, node.to);
            break;
          case 'Emphasis':
            style(mark('cm-np-em'), node.from, node.to);
            break;
          case 'Strikethrough':
            style(mark('cm-np-strike'), node.from, node.to);
            break;
          case 'EmphasisMark':
          case 'StrikethroughMark':
            if (!isActive(node.from)) replace(hide, node.from, node.to);
            break;
          case 'InlineCode':
            style(mark('cm-np-code'), node.from, node.to);
            break;
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode' && !isActive(node.from)) replace(hide, node.from, node.to);
            break;
          case 'FencedCode':
            blockLines('cm-np-codeblock', node.from, node.to, from, to);
            return false;
          case 'Blockquote':
            blockLines('cm-np-quote', node.from, node.to, from, to);
            break;
          case 'QuoteMark': {
            // `> ` reads as the quote's bar (drawn by the line style).
            if (isActive(node.from)) style(mark('cm-np-mark'), node.from, node.to);
            else replace(hide, node.from, state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to);
            break;
          }
          case 'HorizontalRule':
            out.push(lineClass('cm-np-hr').range(state.doc.lineAt(node.from).from));
            if (!isActive(node.from)) style(mark('cm-np-hr-text'), node.from, node.to);
            break;
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            style(mark('cm-np-link', url ? { 'data-href': state.sliceDoc(url.from, url.to) } : undefined), node.from, node.to);
            // Hidden only when the whole link is on one line (it may span lines).
            if (!isActive(node.from) && marks.length >= 2 && oneLine(node.from, node.to)) {
              replace(hide, marks[0].from, marks[0].to);
              replace(hide, marks[1].from, node.to);
            }
            return false;
          }
          case 'Image': {
            // Drawn as the picture itself, off the caret's line (the source shows there).
            const url = node.node.getChild('URL');
            if (!images || !url || isActive(node.from) || !oneLine(node.from, node.to)) return false;
            const marks = node.node.getChildren('LinkMark');
            const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : '';
            replace(Decoration.replace({ widget: new ImageWidget(state.sliceDoc(url.from, url.to), alt) }), node.from, node.to);
            return false;
          }
          case 'ListMark': {
            const item = node.node.parent;
            const task = item?.getChild('Task');
            const text = state.sliceDoc(node.from, node.to);
            if (isActive(node.from) || !/^[-*+]$/.test(text)) break;
            // A task's bullet gives way to its checkbox; a plain item's is drawn as a dot.
            if (task) replace(hide, node.from, Math.min(node.to + 1, task.from));
            else replace(BULLET, node.from, node.to);
            break;
          }
          case 'Task': {
            const marker = node.node.getChild('TaskMarker');
            if (!marker) break;
            const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
            const anchor = TODO_MARKER_TAIL.exec(state.doc.lineAt(node.from).text)?.[1] ?? null;
            replace(Decoration.replace({ widget: new TaskBox(checked, anchor, handlers) }), marker.from, marker.to);
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
        style(mark('cm-np-wikilink', { 'data-wikilink': target }), start, end);
        if (!lineActive) {
          replace(hide, start, start + 2 + (pipe >= 0 ? pipe + 1 : 0));
          replace(hide, end - 2, end);
        }
      }
      // A task line's to-do: its marker as a chip, or the offer to make one.
      if (TASK_LINE.test(line.text) && !inCode(view, line.from)) {
        const tail = TODO_MARKER_TAIL.exec(line.text);
        if (tail) {
          const at = line.from + tail.index;
          markers.push(Decoration.replace({ widget: new TodoChip(tail[1], links.todoOf?.(tail[1]) ?? null, handlers) }).range(at, line.to));
        } else if (links.makeTodo && !view.state.readOnly) {
          out.push(Decoration.widget({ widget: new MakeTodo(n - 1, handlers), side: 1 }).range(line.to));
          if (lineActive) out.push(lineClass('cm-np-task-active').range(line.from));
        }
      }
      for (const m of line.text.matchAll(TAG_RE)) {
        const start = line.from + (m.index ?? 0) + m[1].length;
        // A heading's `#` is followed by a space and never matches; skip code.
        if (inCode(view, start)) continue;
        style(mark('cm-np-tag', { 'data-tag': m[2] }), start, start + m[2].length + 1);
      }
    }
  }
  return { decorations: Decoration.set(out, true), markers: Decoration.set(markers, true) };
}

/**
 * The decorations. Should drawing them throw (a construct not foreseen in
 * `build`), CodeMirror logs it and switches the plugin off ("CodeMirror
 * plugin crashed"): the note shows as plain text and stays editable. No
 * wrapper of our own: it could not catch what CodeMirror throws while it
 * applies decorations, and the plugin's own update is already isolated.
 */
function decorations(images: boolean, handlers: () => LivePreviewHandlers) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      /** The line markers' chips: drawn, and one step for the caret (`atomicRanges`). */
      markers: DecorationSet = Decoration.none;

      constructor(view: EditorView) {
        this.draw(view);
      }

      update(update: ViewUpdate) {
        const relinked = update.transactions.some((tr) => tr.effects.some((e) => e.is(todoLinksChanged)));
        if (relinked || update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.draw(update.view);
        }
      }

      draw(view: EditorView): void {
        ({ decorations: this.decorations, markers: this.markers } = build(view, images, handlers));
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [
    plugin,
    EditorView.decorations.of((view) => view.plugin(plugin)?.markers ?? Decoration.none),
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.markers ?? Decoration.none),
  ];
}

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

/**
 * The live-preview extension set: decorations, link clicks and the paper
 * colours. `images: false` leaves pictures as their markdown (text from
 * another install, whose images are never loaded).
 */
export function livePreview(handlers: () => LivePreviewHandlers, opts: { images?: boolean } = {}) {
  return [decorations(opts.images ?? true, handlers), clicks(handlers), syntaxHighlighting(highlight)];
}
