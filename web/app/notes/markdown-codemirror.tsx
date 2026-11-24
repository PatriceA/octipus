'use client';

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView, keymap, placeholder as placeholderText } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { livePreview } from './live-preview';
import type { NoteIndexEntry, TagCount } from './types';

// ---------------------------------------------------------------------------
// Markdown editor for notes.
//
// CodeMirror 6 (already a dependency via the in-chat code editor). Two custom
// completion sources give the Obsidian-style authoring affordances:
//   • `[[`  → suggest existing note titles (and a "Create …" option), inserting
//            a parser-correct `[[Title]]`.
//   • `#`   → suggest existing tags (ranked by frequency) so we stop spawning
//            near-duplicate spellings of the same tag.
// `closeBrackets` auto-inserts the matching `]]`, so the sources detect an
// existing close and avoid doubling it.
// ---------------------------------------------------------------------------

export interface MarkdownEditorHandle {
  /** Wrap the current selection (or a placeholder) with markdown delimiters. */
  wrap: (before: string, after?: string, placeholder?: string) => void;
  /** Prepend a token to the start of the caret's line (headings/list/quote). */
  linePrefix: (prefix: string) => void;
  /** Insert text at the caret, replacing any selection. */
  insert: (text: string) => void;
  /**
   * Replace the first occurrence of `token` with `text`. Used to swap an
   * upload placeholder for the finished image once the request returns — by
   * then the caret has usually moved, so a position-based insert would land
   * the image wherever the user happens to be typing.
   */
  replaceToken: (token: string, text: string) => void;
  focus: () => void;
}

/** A live document to edit instead of a controlled `value` (space notes, §7.6). */
export interface CollabBinding {
  text: Y.Text;
  awareness: Awareness;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /**
   * Edit this shared document: the editor binds to it with `yCollab`
   * (other members' changes, cursors and selections), and `value` is only
   * read once for the initial text. Remount (a new `key`) to bind another.
   */
  collab?: CollabBinding;
  onSave?: () => void;
  getNotes: () => NoteIndexEntry[];
  getTags: () => TagCount[];
  /** Images pasted or dropped into the editor. */
  onFiles?: (files: File[]) => void;
  /** A click on a `[[wikilink]]` in the text: open that note (the raw target, as typed). */
  onOpenWikilink?: (target: string) => void;
  /** Ctrl/⌘-click on a `#tag` in the text. */
  onTag?: (tag: string) => void;
  /** Shown while the note is empty. */
  placeholder?: string;
  /** Escape in the editor (the page's shortcuts take over once it lets go of the focus). */
  onEscape?: () => void;
  /** Take the focus on mount (a new note: click New and type). */
  autoFocus?: boolean;
  /** Draw `![images]` in the text (false: text from another install, whose images never load). */
  images?: boolean;
}

/**
 * Client mirror of `slugify()` in src/core/knowledge/wikilink.ts — used only to
 * decide whether `[[Title]]` already resolves to a note's slug (root note) or
 * whether we must insert the slug explicitly (foldered note).
 */
function slugifyClient(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9/_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '');
}

/**
 * Image files carried by a paste or drop, in either shape the browser uses:
 * `files` for a real file drop, `items` for a screenshot on the clipboard
 * (which has no entry in `files` in some browsers).
 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    // A clipboard image can appear in BOTH `items` and `files`; de-dupe so one
    // paste doesn't upload the same screenshot twice.
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') add(item.getAsFile());
  }
  for (const file of Array.from(data.files ?? [])) add(file);
  return out;
}

/** Completion source for `[[wikilinks]]`. */
function wikilinkSource(getNotes: () => NoteIndexEntry[]) {
  return (context: CompletionContext): CompletionResult | null => {
    // An open `[[` followed by anything that isn't a close/newline, up to caret.
    const match = context.matchBefore(/\[\[[^\]\n]*/);
    if (!match) return null;
    const typed = match.text.slice(2);
    const from = match.from + 2;
    // `closeBrackets` may have inserted the matching `]]` right after the caret.
    const hasClose = context.state.sliceDoc(context.pos, context.pos + 2) === ']]';
    const q = typed.trim().toLowerCase();

    // `linkText` is what goes inside `[[ ]]`. Wikilinks resolve by SLUG, so for
    // a foldered note (slug !== slugify(title)) we must insert the slug, with
    // the title as a display alias: `[[projects/octipus/specs|Specs]]`. A root
    // note (slug === slugify(title)) stays the clean `[[Specs]]`.
    const insertLink = (linkText: string) => (view: EditorView, _c: Completion, a: number, b: number) => {
      const insert = hasClose ? linkText : `${linkText}]]`;
      view.dispatch({
        changes: { from: a, to: b, insert },
        // Land the caret after the closing `]]` either way.
        selection: { anchor: a + linkText.length + 2 },
      });
    };

    const notes = getNotes();
    const options: Completion[] = notes
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q))
      .slice(0, 50)
      .map((n) => {
        const linkText = slugifyClient(n.title) === n.slug ? n.title : `${n.slug}|${n.title}`;
        return { label: n.title, detail: n.slug, type: 'class', apply: insertLink(linkText) };
      });

    // Offer to create a new note when the typed text isn't an existing title.
    if (q && !notes.some((n) => n.title.toLowerCase() === q)) {
      const title = typed.trim();
      options.push({ label: `Create "${title}"`, type: 'text', apply: insertLink(title), boost: -1 });
    }
    if (options.length === 0) return null;
    return { from, to: context.pos, options, validFor: /[^\]\n]*/ };
  };
}

/** Completion source for `#tags`. */
function tagSource(getTags: () => TagCount[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/#[\w/-]*/);
    if (!match) return null;
    // The `#` must start a word (line start or after whitespace) so we don't
    // fire inside URLs/code; a markdown heading has a space after `#` and so
    // closes the popup as soon as the user types it.
    const before = context.state.sliceDoc(Math.max(0, match.from - 1), match.from);
    if (before && !/\s/.test(before)) return null;
    // An all-digit `#123` is an issue ref, not a tag (mirrors TAG_RE in wikilink.ts).
    if (/^#\d+$/.test(match.text)) return null;
    const typed = match.text.slice(1);
    const q = typed.toLowerCase();
    const options: Completion[] = getTags()
      .filter((t) => !q || t.tag.toLowerCase().includes(q))
      .slice(0, 50)
      .map((t) => ({ label: `#${t.tag}`, detail: String(t.count), type: 'keyword', apply: `#${t.tag}` }));
    if (options.length === 0) return null;
    return { from: match.from, to: context.pos, options, validFor: /^#[\w/-]*$/ };
  };
}

// A sheet of paper: the page's own colours (light and dark), the reading font
// at a comfortable size, no gutter, no active-line band. The live-preview
// styles (headings, checkboxes, links) are in notes.css.
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '16px', backgroundColor: 'transparent', color: 'var(--color-on-surface)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.7',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--color-primary)', padding: '0 0 40vh' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-primary)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--color-primary) 22%, transparent)',
  },
  '.cm-placeholder': { color: 'var(--color-on-surface-variant)', opacity: '0.6' },
  '.cm-gutters': { display: 'none' },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-surface-container)',
    color: 'var(--color-on-surface)',
    border: '1px solid var(--color-outline-variant)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px #0f2a3018',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-primary-container)',
    color: 'var(--color-on-primary-container)',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px', fontFamily: 'var(--font-sans)', fontSize: '13px' },
  '.cm-completionDetail': { marginLeft: '8px', fontStyle: 'normal', color: 'var(--color-on-surface-variant)', fontSize: '11px' },
});

const NotesMarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function NotesMarkdownEditor(
  { value, onChange, onSave, getNotes, getTags, onFiles, collab, onOpenWikilink, onTag, placeholder, onEscape, autoFocus, images = true },
  ref,
) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  // Keep callbacks/data behind refs so the (memoised, stable) extension set
  // always sees the latest values without being torn down on every render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const getNotesRef = useRef(getNotes);
  getNotesRef.current = getNotes;
  const getTagsRef = useRef(getTags);
  getTagsRef.current = getTags;
  const linksRef = useRef({ openWikilink: onOpenWikilink, openTag: onTag });
  linksRef.current = { openWikilink: onOpenWikilink, openTag: onTag };
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  // The live document's undo history (only this member's edits). Made in an
  // effect, so each remount's (and StrictMode's double mount's) manager is
  // destroyed — it listens on the shared Y.Doc until then.
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
  useEffect(() => {
    if (!collab) {
      setUndoManager(null);
      return;
    }
    const manager = new Y.UndoManager(collab.text);
    setUndoManager(manager);
    return () => manager.destroy();
  }, [collab]);

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      autocompletion({
        override: [wikilinkSource(() => getNotesRef.current()), tagSource(() => getTagsRef.current())],
        icons: false,
      }),
      keymap.of([
        {
          // Lets go of the focus (after closing a completion popup, which takes Escape first).
          key: 'Escape',
          run: (view) => {
            if (!onEscapeRef.current) return false;
            view.contentDOM.blur();
            onEscapeRef.current();
            return true;
          },
        },
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
      ]),
      // Paste / drop of image files. A screenshot on the clipboard arrives as a
      // `file` item with no text alternative, so CodeMirror's own paste handling
      // would drop it silently. Only intercept when there ARE image files —
      // pasting text or dragging a text selection must behave normally.
      EditorView.domEventHandlers({
        paste(event) {
          const files = imageFilesFrom(event.clipboardData);
          if (files.length === 0 || !onFilesRef.current) return false;
          event.preventDefault();
          onFilesRef.current(files);
          return true;
        },
        drop(event) {
          const files = imageFilesFrom(event.dataTransfer);
          if (files.length === 0 || !onFilesRef.current) return false;
          event.preventDefault();
          onFilesRef.current(files);
          return true;
        },
      }),
      editorTheme,
      livePreview(() => linksRef.current, { images }),
      ...(placeholder ? [placeholderText(placeholder)] : []),
      // Bound once this document's manager exists (never another's).
      ...(collab && undoManager && undoManager.scope.includes(collab.text)
        ? [yCollab(collab.text, collab.awareness, { undoManager })]
        : []),
    ],
    [collab, undoManager, placeholder, images],
  );
  // Bound to a live document, the editor starts from its text and is then
  // driven by yCollab alone: a changing `value` prop would fight it.
  const initial = useMemo(() => (collab ? collab.text.toString() : null), [collab]);

  useImperativeHandle(ref, () => ({
    wrap(before, after = before, placeholder = 'text') {
      const view = cmRef.current?.view;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const sel = view.state.sliceDoc(from, to) || placeholder;
      const insert = before + sel + after;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + before.length, head: from + before.length + sel.length },
      });
      view.focus();
    },
    linePrefix(prefix) {
      const view = cmRef.current?.view;
      if (!view) return;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      view.dispatch({
        changes: { from: line.from, insert: prefix },
        selection: { anchor: head + prefix.length },
      });
      view.focus();
    },
    insert(text) {
      const view = cmRef.current?.view;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    },
    replaceToken(token, text) {
      const view = cmRef.current?.view;
      if (!view) return;
      const at = view.state.doc.toString().indexOf(token);
      if (at < 0) return; // the user deleted the placeholder — respect that
      view.dispatch({ changes: { from: at, to: at + token.length, insert: text } });
    },
    focus() {
      cmRef.current?.view?.focus();
    },
  }));

  return (
    <CodeMirror
      ref={cmRef}
      value={initial ?? value}
      onChange={onChange}
      autoFocus={autoFocus}
      // Its default theme paints the editor white: the paper theme above has the page's colours.
      theme="none"
      height="100%"
      style={{ height: '100%' }}
      extensions={extensions}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        // The live preview brings its own colours (light and dark).
        syntaxHighlighting: false,
        autocompletion: false, // we supply our own with custom sources
        bracketMatching: true,
        closeBrackets: true,
        // A live document undoes through its own Y.UndoManager (only this
        // member's edits), not CodeMirror's history.
        history: !collab,
        historyKeymap: !collab,
      }}
    />
  );
});

export default NotesMarkdownEditor;
