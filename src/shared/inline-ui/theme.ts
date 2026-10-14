/**
 * Theme tokens shared by live artifacts (`ARTIFACT_BASE_CSS`) and interactive
 * answers. One source, so an answer saved as an artifact keeps its look.
 */
export type ThemeTokens = Readonly<Record<string, string>>;

export const OCTI_FONT_TOKENS: ThemeTokens = {
  '--octi-mono': 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
  '--octi-sans': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

export const OCTI_LIGHT_TOKENS: ThemeTokens = {
  '--octi-surface': '#fafaf9',
  '--octi-surface-container': '#f5f5f4',
  '--octi-surface-container-high': '#ececeb',
  '--octi-on-surface': '#1c1b1f',
  '--octi-on-surface-variant': '#49454f',
  '--octi-outline': '#d6d3d1',
  '--octi-outline-variant': '#e7e5e4',
  '--octi-primary': '#6750a4',
  '--octi-link': '#4f46e5',
  '--octi-error': '#b91c1c',
  '--octi-success': '#15803d',
  '--octi-warning': '#b45309',
};

/** Dark values; tokens not listed here keep their light value. */
export const OCTI_DARK_OVERRIDES: ThemeTokens = {
  '--octi-surface': '#1c1b1f',
  '--octi-surface-container': '#211f24',
  '--octi-surface-container-high': '#2b2930',
  '--octi-on-surface': '#e6e1e5',
  '--octi-on-surface-variant': '#cac4d0',
  '--octi-outline': '#49454f',
  '--octi-outline-variant': '#36343b',
  '--octi-link': '#a5b4fc',
};

export const OCTI_DARK_TOKENS: ThemeTokens = { ...OCTI_LIGHT_TOKENS, ...OCTI_DARK_OVERRIDES };

export function tokenDeclarations(tokens: ThemeTokens, indent = '  '): string {
  return Object.entries(tokens).map(([k, v]) => `${indent}${k}: ${v};`).join('\n');
}

export type InlineUiTheme = 'dark' | 'light';

/**
 * Base CSS inside an interactive-answer frame: the tokens for the app's theme
 * (passed in, never read from the OS — the app is dark-only today, and a light
 * OS must not produce a light frame in a dark chat) and readable defaults for
 * text and form controls.
 */
export function inlineUiBaseCss(theme: InlineUiTheme): string {
  const tokens = theme === 'dark' ? OCTI_DARK_TOKENS : OCTI_LIGHT_TOKENS;
  return `:root {
  color-scheme: ${theme};
${tokenDeclarations({ ...OCTI_FONT_TOKENS, ...tokens })}
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font-family: var(--octi-sans); font-size: 14px; line-height: 1.55; color: var(--octi-on-surface); padding: 2px; overflow-wrap: anywhere; }
h1, h2, h3, h4 { margin: 0 0 0.5em; line-height: 1.3; }
p { margin: 0 0 0.75em; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: var(--octi-surface-container-high); border: 1px solid var(--octi-outline); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--octi-on-surface-variant); }
input, select, textarea { background: var(--octi-surface-container); border: 1px solid var(--octi-outline); border-radius: 6px; padding: 4px 8px; max-width: 100%; }
:focus-visible { outline: 2px solid var(--octi-link); outline-offset: 2px; }
[data-octi-href] { color: var(--octi-link); cursor: pointer; text-decoration: underline; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--octi-outline-variant); }
svg { max-width: 100%; height: auto; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }`;
}
