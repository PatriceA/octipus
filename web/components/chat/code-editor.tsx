'use client';

import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';

// CodeMirror 6 wrapper for the in-chat file view (Thread 2). One instance
// serves both read-only viewing (`editable={false}`) and editing, so the
// syntax highlight is identical in both modes. The language grammar is loaded
// lazily by filename via @codemirror/language-data — only the grammars a user
// actually opens are pulled in, keeping the initial bundle small.

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  editable: boolean;
  /** Filename used to pick the syntax-highlight grammar. */
  filename: string;
  height?: string;
}

// Slightly tighten CodeMirror's defaults to match the chat's compact density.
const baseTheme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: '#0d1117' },
  '.cm-gutters': { backgroundColor: '#0d1117', border: 'none' },
  '.cm-content': { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
});

export default function CodeEditor({ value, onChange, editable, filename, height = '60vh' }: CodeEditorProps) {
  const [langExt, setLangExt] = useState<Extension[]>([]);

  useEffect(() => {
    let cancelled = false;
    const desc = LanguageDescription.matchFilename(languages, filename);
    if (!desc) {
      setLangExt([]);
      return;
    }
    desc
      .load()
      .then((support) => {
        if (!cancelled) setLangExt([support]);
      })
      .catch(() => {
        // No grammar available — fall back to plain text rather than failing.
        if (!cancelled) setLangExt([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filename]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      editable={editable}
      readOnly={!editable}
      height={height}
      theme={oneDark}
      extensions={[baseTheme, EditorView.lineWrapping, ...langExt]}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: editable,
        highlightActiveLineGutter: editable,
      }}
    />
  );
}
