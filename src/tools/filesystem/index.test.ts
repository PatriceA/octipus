import { describe, test, expect } from 'bun:test';
import { autoIndexPurpose } from './index';

/**
 * Locks the auto-index-on-write policy: prose/docs are indexed into RAG,
 * code/config are NOT (agents read source directly; chunks of edited code go
 * stale). A regression here — e.g. re-adding `.ts` to the extension set —
 * silently resurrects the stale-code-chunk problem, so guard it explicitly.
 */
describe('filesystem.autoIndexPurpose', () => {
  test('prose/doc extensions → "document"', () => {
    expect(autoIndexPurpose('notes.md')).toBe('document');
    expect(autoIndexPurpose('README.rst')).toBe('document');
    expect(autoIndexPurpose('export.csv')).toBe('document');
    expect(autoIndexPurpose('server.log')).toBe('document');
    expect(autoIndexPurpose('plain.txt')).toBe('document');
  });

  test('code extensions → null (never auto-indexed on write)', () => {
    for (const f of ['app.ts', 'main.py', 'index.tsx', 'lib.rs', 'svc.go', 'Main.java', 'run.sh', 'q.sql']) {
      expect(autoIndexPurpose(f)).toBeNull();
    }
  });

  test('config/structured formats → null (small, structured, read directly)', () => {
    for (const f of ['pkg.json', 'config.yaml', 'config.yml', 'app.toml', 'settings.ini', 'page.html', 'style.css']) {
      expect(autoIndexPurpose(f)).toBeNull();
    }
  });

  test('extension match is case-insensitive', () => {
    expect(autoIndexPurpose('NOTES.MD')).toBe('document');
    expect(autoIndexPurpose('Data.CSV')).toBe('document');
  });

  test('full paths and dotfiles resolve by final extension', () => {
    expect(autoIndexPurpose('/abs/workspace/docs/guide.md')).toBe('document');
    expect(autoIndexPurpose('/abs/src/deep/nested/module.ts')).toBeNull();
    expect(autoIndexPurpose('Makefile')).toBeNull(); // no extension
    expect(autoIndexPurpose('archive.tar.gz')).toBeNull(); // .gz, not a doc
  });
});
