/**
 * Color palette for the TUI editor.
 *
 * Two themes: `dark` (default) and `light`. Each one maps the
 * semantic surfaces of the editor (border, accent, status, diff
 * gutter, syntax tokens) to terminal-safe color strings that Ink's
 * `<Text color>` accepts (named colors or `#RRGGBB`).
 *
 * Selection is exposed via `getTheme()` instead of a global so a
 * `/theme` command can swap it at runtime without re-importing.
 */
export interface Theme {
  name: 'dark' | 'light';
  // Surfaces
  fg: string;
  bg: string;
  dim: string;
  border: string;
  borderFocus: string;
  accent: string;
  accentDim: string;
  warn: string;
  error: string;
  ok: string;
  // Status / mode bar
  statusBg: string;
  statusFg: string;
  // Editor
  lineNumber: string;
  lineNumberCurrent: string;
  cursor: string;
  selection: string;
  diffAdd: string;
  diffDel: string;
  // Syntax tokens
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
    function: string;
    type: string;
    operator: string;
    punctuation: string;
  };
}

const dark: Theme = {
  name: 'dark',
  fg: '#E6E6E6',
  bg: '#0F1216',
  dim: 'gray',
  border: '#3A4250',
  borderFocus: '#7AA2D4',
  accent: '#7AA2D4',
  accentDim: '#A0B8CF',
  warn: '#E0AF68',
  error: '#C47070',
  ok: '#7BC4A0',
  statusBg: '#1A1F26',
  statusFg: '#A0B8CF',
  lineNumber: '#5A6677',
  lineNumberCurrent: '#A0B8CF',
  cursor: '#7AA2D4',
  selection: '#26334A',
  diffAdd: '#7BC4A0',
  diffDel: '#C47070',
  syntax: {
    keyword: '#C792EA',
    string: '#A0E6A0',
    number: '#F78C6C',
    comment: '#5A6677',
    function: '#7AA2D4',
    type: '#FFCB6B',
    operator: '#89DDFF',
    punctuation: '#A0B8CF',
  },
};

const light: Theme = {
  name: 'light',
  fg: '#1F2328',
  bg: '#FFFFFF',
  dim: 'gray',
  border: '#D0D7DE',
  borderFocus: '#0969DA',
  accent: '#0969DA',
  accentDim: '#57606A',
  warn: '#9A6700',
  error: '#CF222E',
  ok: '#1F883D',
  statusBg: '#F6F8FA',
  statusFg: '#57606A',
  lineNumber: '#8C959F',
  lineNumberCurrent: '#1F2328',
  cursor: '#0969DA',
  selection: '#DDEBF8',
  diffAdd: '#1F883D',
  diffDel: '#CF222E',
  syntax: {
    keyword: '#CF222E',
    string: '#0A3069',
    number: '#0550AE',
    comment: '#6E7781',
    function: '#8250DF',
    type: '#953800',
    operator: '#0550AE',
    punctuation: '#1F2328',
  },
};

let active: Theme = dark;
export function getTheme(): Theme { return active; }
export function setTheme(name: 'dark' | 'light'): void {
  active = name === 'dark' ? dark : light;
}
export function listThemes(): readonly ('dark' | 'light')[] { return ['dark', 'light']; }
