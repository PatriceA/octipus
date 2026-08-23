import { describe, expect, test } from 'vitest';
import { CodeFileNotIndexableError, isCodeFile } from './code-detection';
import { getFileIndexer } from './indexer';

describe('isCodeFile', () => {
  test('classifies source-code files as code', () => {
    for (const p of [
      '/repo/src/index.ts', 'a.tsx', 'b.js', 'c.mjs', 'main.go', 'lib.rs',
      'app.py', 'x.rb', 'y.java', 'z.kt', 'q.c', 'r.cpp', 'w.cs', 's.swift',
      'comp.vue', 'page.svelte', 'script.sh', 'mod.php',
    ]) {
      expect(isCodeFile(p)).toBe(true);
    }
  });

  test('does NOT classify prose/data files as code', () => {
    for (const p of [
      'README.md', 'notes.txt', 'doc.rst', 'data.csv', 'run.log',
      'AGENTS.md', 'LICENSE', 'noext', '/a/b/c',
    ]) {
      expect(isCodeFile(p)).toBe(false);
    }
  });

  test('classifies extension-less code/build files by basename', () => {
    for (const p of ['Dockerfile', '/repo/Makefile', 'a/b/Gemfile', 'Jenkinsfile']) {
      expect(isCodeFile(p)).toBe(true);
    }
  });

  test('is case-insensitive on the extension', () => {
    expect(isCodeFile('Foo.TS')).toBe(true);
    expect(isCodeFile('Bar.Py')).toBe(true);
  });
});

describe('FileIndexer code guard', () => {
  test('indexFile refuses a raw code file before touching the filesystem', async () => {
    const indexer = getFileIndexer();
    // The guard runs before the existence check, so a non-existent path is fine.
    await expect(indexer.indexFile('/nonexistent/repo/src/server.ts')).rejects.toBeInstanceOf(CodeFileNotIndexableError);
  });

  test('indexFile rejects code even when purpose is "document" (closes the glob bypass)', async () => {
    const indexer = getFileIndexer();
    await expect(indexer.indexFile('/nonexistent/repo/src/util.py', 'document')).rejects.toBeInstanceOf(CodeFileNotIndexableError);
  });
});
