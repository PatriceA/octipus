/**
 * Default themes for the pi-tui-based octipus shell.
 *
 * Ports the dark/light palettes from src/tui-editor/theme.ts and
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
  fg: '#E6E6E6',
  dim: '#5A6677',
  border: '#3A4250',
  borderFocus: '#7AA2D4',
  accent: '#7AA2D4',
  accentDim: '#A0B8CF',
  warn: '#E0AF68',
  error: '#C47070',
  ok: '#7BC4A0',
  statusFg: '#A0B8CF',
  selection: '#26334A',
  cursor: '#7AA2D4',
  cursorFg: '#0F1216',
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
