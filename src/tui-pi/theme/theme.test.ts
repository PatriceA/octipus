import { afterEach, describe, expect, test } from 'vitest';
import { contrast, getMarkdownTheme, getPalette, type OctipusPalette, PALETTE_BACKGROUNDS, PALETTE_NAMES, paletteForBackground, paletteNamed, setPalette } from './defaults';

afterEach(() => setPalette('dark'));

/** Text roles are read; borders only have to be seen (WCAG 1.4.3 and 1.4.11). High contrast asks for the enhanced levels. */
const TEXT: ReadonlyArray<keyof OctipusPalette> = ['fg', 'dim', 'accent', 'accentDim', 'warn', 'error', 'ok', 'statusFg', 'borderFocus'];
const NON_TEXT: ReadonlyArray<keyof OctipusPalette> = ['border'];

describe('palettes', () => {
  test.each(PALETTE_NAMES)('%s: every role is readable on every background it is made for', name => {
    const palette = paletteNamed(name);
    const text = name === 'high-contrast' ? 7 : 4.5;
    const nonText = name === 'high-contrast' ? 4.5 : 3;
    const failures: string[] = [];
    for (const background of PALETTE_BACKGROUNDS[name]) {
      for (const role of TEXT) {
        const ratio = contrast(palette[role] as string, background);
        if (ratio < text) failures.push(`${role} ${palette[role]} on ${background}: ${ratio.toFixed(2)} < ${text}`);
      }
      for (const role of NON_TEXT) {
        const ratio = contrast(palette[role] as string, background);
        if (ratio < nonText) failures.push(`${role} ${palette[role]} on ${background}: ${ratio.toFixed(2)} < ${nonText}`);
      }
    }
    // Text drawn on the palette's own backgrounds: selected text, the editor cursor.
    if (contrast(palette.fg, palette.selection) < text) failures.push(`fg on selection: ${contrast(palette.fg, palette.selection).toFixed(2)}`);
    if (contrast(palette.cursorFg, palette.cursor) < text) failures.push(`cursorFg on cursor: ${contrast(palette.cursorFg, palette.cursor).toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  test('contrast is the WCAG ratio', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
  });

  test('the terminal background picks dark or light', () => {
    expect(paletteForBackground({ r: 255, g: 255, b: 255 })).toBe('light');
    expect(paletteForBackground({ r: 253, g: 246, b: 227 })).toBe('light'); // Solarized light
    expect(paletteForBackground({ r: 0, g: 43, b: 54 })).toBe('dark'); // Solarized dark
    expect(paletteForBackground({ r: 30, g: 30, b: 30 })).toBe('dark');
  });

  test('style functions follow a switch made after they were created', () => {
    const theme = getMarkdownTheme();
    const before = theme.heading('x');
    setPalette('light');
    expect(getPalette().name).toBe('light');
    expect(theme.heading('x')).not.toBe(before);
    expect(theme.heading('x')).toContain('38;2;9;105;218');
  });
});
