/**
 * Default themes for the pi-tui-based octipus shell.
 *
 * Shares the Deep Sea dark identity with the web workspace and
 * adapts them to pi-tui's chalk-driven theme contracts
 * (EditorTheme, MarkdownTheme, SelectListTheme).
 *
 * Phase 6 will replace these with JSON files watched under
 * ~/.octipus/themes/. For Phase 1 the bundled defaults are enough.
 */
import { Chalk } from 'chalk';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@mariozechner/pi-tui';

const chalk = new Chalk({ level: 3 });

export interface OctipusPalette {
  name: 'dark' | 'light';
  fg: string;
  dim: string;
  border: string;
  borderFocus: string;
  accent: string;
  accentDim: string;
  warn: string;
  error: string;
  ok: string;
  statusFg: string;
  selection: string;
  /** Background applied to the editor's character at the cursor. */
  cursor: string;
  /** Foreground used for the character at the cursor (paired with `cursor` bg). */
  cursorFg: string;
}

const dark: OctipusPalette = {
  name: 'dark',
  fg: '#edf5f3',
  dim: '#a6babd',
  border: '#34515b',
  borderFocus: '#92c9c5',
  accent: '#92c9c5',
  accentDim: '#b9ded9',
  warn: '#e8c46a',
  error: '#f28b82',
  ok: '#7fd39a',
  statusFg: '#b9ded9',
  selection: '#163b44',
  cursor: '#92c9c5',
  cursorFg: '#071923',
};

const light: OctipusPalette = {
  name: 'light',
  fg: '#1F2328',
  dim: '#6E7781',
  border: '#D0D7DE',
  borderFocus: '#0969DA',
  accent: '#0969DA',
  accentDim: '#57606A',
  warn: '#9A6700',
  error: '#CF222E',
  ok: '#1F883D',
  statusFg: '#57606A',
  selection: '#DDEBF8',
  cursor: '#0969DA',
  cursorFg: '#FFFFFF',
};

let active: OctipusPalette = dark;

export function getPalette(): OctipusPalette {
  return active;
}

export function setPalette(name: 'dark' | 'light'): void {
  active = name === 'dark' ? dark : light;
}

export function listPalettes(): readonly ('dark' | 'light')[] {
  return ['dark', 'light'];
}

export function getSelectListTheme(): SelectListTheme {
  const p = active;
  return {
    selectedPrefix: (text) => chalk.hex(p.accent)(text),
    selectedText: (text) => chalk.bold(text),
    description: (text) => chalk.hex(p.dim)(text),
    scrollInfo: (text) => chalk.hex(p.dim)(text),
    noMatch: (text) => chalk.hex(p.dim)(text),
  };
}

export function getMarkdownTheme(): MarkdownTheme {
  const p = active;
  return {
    heading: (text) => chalk.bold.hex(p.accent)(text),
    link: (text) => chalk.hex(p.accent)(text),
    linkUrl: (text) => chalk.hex(p.dim)(text),
    code: (text) => chalk.hex(p.warn)(text),
    codeBlock: (text) => chalk.hex(p.ok)(text),
    codeBlockBorder: (text) => chalk.hex(p.dim)(text),
    quote: (text) => chalk.italic(text),
    quoteBorder: (text) => chalk.hex(p.dim)(text),
    hr: (text) => chalk.hex(p.dim)(text),
    listBullet: (text) => chalk.hex(p.accent)(text),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
  };
}

export function getEditorTheme(): EditorTheme {
  const p = active;
  return {
    borderColor: (text) => chalk.hex(p.border)(text),
    selectList: getSelectListTheme(),
  };
}

export function colorFor(role: 'user' | 'assistant' | 'system' | 'error'): (text: string) => string {
  const p = active;
  switch (role) {
    case 'user':      return (t) => chalk.hex(p.ok)(t);
    case 'assistant': return (t) => chalk.hex(p.fg)(t);
    case 'system':    return (t) => chalk.hex(p.dim)(t);
    case 'error':     return (t) => chalk.hex(p.error)(t);
  }
}

export { chalk };
