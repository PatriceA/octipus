/**
 * tree-sitter that cannot be loaded used to fall back to the line
 * highlighter in silence (`catch { return null }`): the user saw plain
 * highlighting and no reason. The reason is now told, once.
 */
import { expect, test, vi } from 'vitest';

vi.mock('web-tree-sitter', () => { throw new Error('wasm runtime missing'); });

test('a tree-sitter module that does not load is told once, and highlighting still works', async () => {
  const { onHighlighterProblem, setSource } = await import('./highlight-tree-sitter');
  await setSource('buffer:1', 'typescript', 'const a = 1;');
  await setSource('buffer:2', 'typescript', 'const b = 2;');
  const told: string[] = [];
  const stop = onHighlighterProblem((problem) => told.push(problem));
  expect(told).toHaveLength(1);
  expect(told[0]).toMatch(/^Syntax highlighting uses the line highlighter: web-tree-sitter could not be loaded \(.+\)\.$/);
  stop();
});
