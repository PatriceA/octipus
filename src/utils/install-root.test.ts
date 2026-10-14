import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { octipusRoot } from './install-root';

describe('octipusRoot', () => {
  test('finds the checkout from a source module and from the bundle directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'octipus-root-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'octipus' }));
    mkdirSync(join(root, 'src', 'voice'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    expect(octipusRoot(join(root, 'src', 'voice'))).toBe(root);
    expect(octipusRoot(join(root, 'dist'))).toBe(root);
  });

  test('skips a package.json that belongs to something else', () => {
    const root = mkdtempSync(join(tmpdir(), 'octipus-root-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'octipus' }));
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep' }));
    expect(octipusRoot(join(root, 'node_modules', 'dep'))).toBe(root);
  });

  test('throws outside any install', () => {
    expect(() => octipusRoot(mkdtempSync(join(tmpdir(), 'no-octipus-')))).toThrow(/Cannot locate/);
  });

  test('the default resolves this repository', () => {
    expect(octipusRoot()).toBe(process.cwd());
  });
});
