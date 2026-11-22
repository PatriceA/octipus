import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseTerminalArgs, readSettingsFile, resolveTerminalSettings } from './settings';
import { parseProjectArg } from './index';

const file = (content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'tui-settings-')), 'tui.json');
  writeFileSync(path, content);
  return path;
};

test('defaults: the alternate screen and app mouse; no file is no settings', () => {
  expect(resolveTerminalSettings([], join(tmpdir(), 'does-not-exist', 'tui.json'))).toEqual({ screen: 'alt', mouse: 'app' });
});

test('the file sets tui.mouse; flags win over it', () => {
  const path = file('{ "mouse": "native" }');
  expect(readSettingsFile(path)).toEqual({ mouse: 'native' });
  expect(resolveTerminalSettings([], path)).toEqual({ screen: 'alt', mouse: 'native' });
  expect(resolveTerminalSettings(['--mouse', 'off', '--inline'], path)).toEqual({ screen: 'inline', mouse: 'off' });
});

test('a bad value fails loudly, naming the file and the choices', () => {
  expect(() => readSettingsFile(file('{ "mouse": "sometimes" }'))).toThrow(/tui\.json: mouse: .*app, native, off/);
  expect(() => readSettingsFile(file('{ "mous": "app" }'))).toThrow(/tui\.json/);
  expect(() => readSettingsFile(file('{ nope'))).toThrow(/not valid JSON/);
  expect(() => parseTerminalArgs(['--mouse'])).toThrow('--mouse takes one of app, native, off');
  expect(() => parseTerminalArgs(['--mouse', 'x'])).toThrow('(got "x")');
});

test('the mouse mode after --mouse is not taken for the project path', () => {
  expect(parseProjectArg(['--mouse', 'native'])).toBeUndefined();
  expect(parseProjectArg(['--inline', '--mouse', 'off', '/work/repo'])).toBe('/work/repo');
});
