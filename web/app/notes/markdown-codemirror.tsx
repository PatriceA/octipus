'use client';

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
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
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  getNotes: () => NoteIndexEntry[];
  getTags: () => TagCount[];
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

// Blend CodeMirror into the terminal surface: transparent background (oneDark
// ships its own dark slab we don't want), mono font, periwinkle caret, roomy
// line-height for prose.
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
    lineHeight: '1.7',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: '#8CACFF', paddingBlock: '6px' },
  '.cm-cursor': { borderLeftColor: '#8CACFF' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#5a5a5a' },
  '.cm-activeLine': { backgroundColor: 'rgba(140,172,255,0.05)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-tooltip': {
    backgroundColor: '#1C1C1C',
    border: '1px solid #2A2A2A',
    borderRadius: '4px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: '#1F2A4A',
    color: '#fff',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 6px', fontFamily: 'var(--font-mono, monospace)' },
});

const NotesMarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function NotesMarkdownEditor(
  { value, onChange, onSave, getNotes, getTags },
  ref,
) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  // Keep callbacks/data behind refs so the (memoised, stable) extension set
  // always sees the latest values without being torn down on every render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const getNotesRef = useRef(getNotes);
  getNotesRef.current = getNotes;
  const getTagsRef = useRef(getTags);
  getTagsRef.current = getTags;

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
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
      ]),
      oneDark,
      editorTheme,
    ],
    [],
  );

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
    focus() {
      cmRef.current?.view?.focus();
    },
  }));

  return (
    <CodeMirror
      ref={cmRef}
      value={value}
      onChange={onChange}
      height="100%"
      style={{ height: '100%' }}
      extensions={extensions}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: true,
        autocompletion: false, // we supply our own with custom sources
        bracketMatching: true,
        closeBrackets: true,
      }}
    />
  );
});

export default NotesMarkdownEditor;
