/**
 * Themes for both terminal surfaces.
 *
 * Three palettes: `dark` (the Deep Sea identity shared with the web
 * workspace), `light`, and `high-contrast` (white on black). Which one is
 * active follows the `theme` setting (`~/.octipus/tui.json`, `/theme`):
 * `auto` (default) asks the terminal for its background (OSC 11) and picks
 * dark or light from its luminance, keeping dark when the terminal does not
 * answer.
 *
 * Every style function reads the active palette when it runs, not when it
 * was made, so switching theme only needs the components to drop their
 * cached rows (`tui.invalidate()`).
 *
 * `NO_COLOR` (any non-empty value, https://no-color.org) turns colour off:
 * text keeps its bold/italic/underline, which is how roles stay apart.
 *
 * `theme.test.ts` checks every role of every palette against the
 * backgrounds it is meant for (WCAG contrast).
 */
import { Chalk } from 'chalk';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@/tui-kit';
import type { FuzzyListTheme } from '@/tui-kit/fuzzy-list';

const chalk = new Chalk({ level: process.env.NO_COLOR ? 0 : 3 });

export const PALETTE_NAMES = ['dark', 'light', 'high-contrast'] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];
export const THEME_SETTINGS = ['auto', ...PALETTE_NAMES] as const;
export type ThemeSetting = (typeof THEME_SETTINGS)[number];

export interface OctipusPalette {
  name: PaletteName;
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
  /** Background of selected text; `fg` is drawn on it. */
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
  border: '#5e8590',
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
  dim: '#636c76',
  border: '#818b98',
  borderFocus: '#0969DA',
  accent: '#0969DA',
  accentDim: '#57606A',
  warn: '#8a5a00',
  error: '#CF222E',
  ok: '#1a7f37',
  statusFg: '#57606A',
  selection: '#DDEBF8',
  cursor: '#0969DA',
  cursorFg: '#FFFFFF',
};

const highContrast: OctipusPalette = {
  name: 'high-contrast',
  fg: '#ffffff',
  dim: '#d0d0d0',
  border: '#a0a0a0',
  borderFocus: '#ffff00',
  accent: '#5fd7ff',
  accentDim: '#afd7ff',
  warn: '#ffd75f',
  error: '#ff8787',
  ok: '#87ff87',
  statusFg: '#ffffff',
  selection: '#00005f',
  cursor: '#ffffff',
  cursorFg: '#000000',
};

const PALETTES: Record<PaletteName, OctipusPalette> = { dark, light, 'high-contrast': highContrast };

/** The terminal backgrounds each palette is made for; the contrast test checks every role against each. */
export const PALETTE_BACKGROUNDS: Record<PaletteName, readonly string[]> = {
  dark: ['#071923', '#000000', '#282c34'],
  light: ['#ffffff', '#f6f8fa'],
  'high-contrast': ['#000000'],
};

let active: OctipusPalette = dark;

export function getPalette(): OctipusPalette {
  return active;
}

export function setPalette(name: PaletteName): void {
  active = PALETTES[name];
}

export function listPalettes(): readonly PaletteName[] {
  return PALETTE_NAMES;
}

export function paletteNamed(name: PaletteName): OctipusPalette {
  return PALETTES[name];
}

/** Whether colour is off (`NO_COLOR`). */
export function colourOff(): boolean {
  return chalk.level === 0;
}

/** Relative luminance (WCAG 2) of `#rrggbb`. */
export function luminance(hex: string): number {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** WCAG contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The palette for a terminal background (OSC 11 reply, 0–255 channels): light on a light one, dark otherwise. */
export function paletteForBackground(rgb: { r: number; g: number; b: number }): 'dark' | 'light' {
  const hex = `#${[rgb.r, rgb.g, rgb.b].map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
  return luminance(hex) > 0.4 ? 'light' : 'dark';
}

export function getSelectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (text) => chalk.hex(active.accent)(text),
    selectedText: (text) => chalk.bold(text),
    description: (text) => chalk.hex(active.dim)(text),
    scrollInfo: (text) => chalk.hex(active.dim)(text),
    noMatch: (text) => chalk.hex(active.dim)(text),
  };
}

export function getFuzzyListTheme(): FuzzyListTheme {
  return {
    border: (text) => chalk.hex(active.border)(text),
    title: (text) => chalk.bold.hex(active.accent)(text),
    selected: (text) => chalk.bold.hex(active.accent)(text),
    dim: (text) => chalk.hex(active.dim)(text),
  };
}

export function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text) => chalk.bold.hex(active.accent)(text),
    link: (text) => chalk.underline.hex(active.accent)(text),
    linkUrl: (text) => chalk.hex(active.dim)(text),
    code: (text) => chalk.hex(active.warn)(text),
    codeBlock: (text) => chalk.hex(active.ok)(text),
    codeBlockBorder: (text) => chalk.hex(active.dim)(text),
    quote: (text) => chalk.italic(text),
    quoteBorder: (text) => chalk.hex(active.dim)(text),
    hr: (text) => chalk.hex(active.dim)(text),
    listBullet: (text) => chalk.hex(active.accent)(text),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
  };
}

export function getEditorTheme(): EditorTheme {
  return {
    borderColor: (text) => chalk.hex(active.border)(text),
    selectList: getSelectListTheme(),
  };
}

export function colorFor(role: 'user' | 'assistant' | 'system' | 'error'): (text: string) => string {
  switch (role) {
    case 'user':      return (t) => chalk.hex(active.ok)(t);
    case 'assistant': return (t) => chalk.hex(active.fg)(t);
    case 'system':    return (t) => chalk.hex(active.dim)(t);
    case 'error':     return (t) => chalk.hex(active.error)(t);
  }
}

export { chalk };
