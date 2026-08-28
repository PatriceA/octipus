import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { checkNamedPaths, premiseNoteFor, renderPremiseNote } from './premise';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'premise-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'qa-loop.py'), 'def one():\n    return 1\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1;\n');
});

describe('naming a path that is not there', () => {
  test('a file that exists is reported present', () => {
    const r = checkNamedPaths('Fix the typo in qa-loop.py please', [root]);
    expect(r.present).toEqual(['qa-loop.py']);
    expect(r.missing).toEqual([]);
  });

  test('a file that does not exist is reported missing', () => {
    const r = checkNamedPaths('Fix the typo in qa-loop2.py please', [root]);
    expect(r.missing).toEqual(['qa-loop2.py']);
  });

  test('a nested path resolves against the root', () => {
    expect(checkNamedPaths('see src/app.ts', [root]).present).toEqual(['src/app.ts']);
    expect(checkNamedPaths('see src/gone.ts', [root]).missing).toEqual(['src/gone.ts']);
  });

  test('a hit under any of several roots counts as present', () => {
    const r = checkNamedPaths('qa-loop.py', ['/nonexistent-root', root]);
    expect(r.present).toEqual(['qa-loop.py']);
  });

  test('quotes and backticks around the path do not hide it', () => {
    expect(checkNamedPaths('the file `qa-loop.py` and "src/app.ts"', [root]).present).toEqual([
      'qa-loop.py',
      'src/app.ts',
    ]);
  });

  test('each path is reported once however often it is named', () => {
    const r = checkNamedPaths('gone.ts, then gone.ts, and gone.ts again', [root]);
    expect(r.missing).toEqual(['gone.ts']);
  });
});

describe('what is not a path', () => {
  test('prose that merely contains dots is left alone', () => {
    const r = checkNamedPaths(
      'Upgrade to 1.2.3, read https://example.com/docs.md, ping octipus.cc, e.g. today.',
      [root],
    );
    expect(r.missing).toEqual([]);
    expect(r.present).toEqual([]);
  });

  test('an extension nobody ships is not treated as a file', () => {
    expect(checkNamedPaths('the thing.whatever is broken', [root]).missing).toEqual([]);
  });
});

describe('a path the task is asking to create', () => {
  test('is not reported missing — that is the most ordinary task there is', () => {
    for (const brief of [
      'create src/api/routes/widgets.ts with a GET handler',
      'Add a new file report.md summarising the run',
      'write test_thing.py covering the parser',
      'scaffold config/settings.yaml',
    ]) {
      expect(checkNamedPaths(brief, [root]).missing, brief).toEqual([]);
    }
  });

  test('a change task still reports it', () => {
    expect(checkNamedPaths('fix the typo in gone.ts', [root]).missing).toEqual(['gone.ts']);
    expect(checkNamedPaths('the file gone.ts contains a bug', [root]).missing).toEqual(['gone.ts']);
  });

  test('the create verb has to be near the path, not anywhere in the brief', () => {
    const far =
      'create a summary of the situation. Then, in a completely separate step that ' +
      'follows on from the earlier discussion about the parser and its behaviour, ' +
      'fix the typo in gone.ts';
    expect(checkNamedPaths(far, [root]).missing).toEqual(['gone.ts']);
  });
});

describe('nothing outside the workspace is ever stat\'d', () => {
  test('a relative token that climbs out is not checkable', () => {
    const r = checkNamedPaths('see a/../../../etc/resolv.conf', [root]);
    expect(r.present).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  test('an absolute token outside every root is not checkable', () => {
    const r = checkNamedPaths('read /etc/resolv.conf', [root]);
    expect(r.present).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  test('an absolute token inside a root still resolves', () => {
    const r = checkNamedPaths(`open ${root}/qa-loop.py`, [root]);
    expect(r.present).toEqual([`${root}/qa-loop.py`]);
  });
});

describe('the note', () => {
  test('there is no note when nothing is missing', () => {
    expect(renderPremiseNote({ present: ['a.ts'], missing: [] })).toBeNull();
    expect(premiseNoteFor('qa-loop.py', [root])).toBeNull();
  });

  test('the note names the path and forbids substituting for it', () => {
    const note = premiseNoteFor('fix qa-loop2.py', [root]);
    expect(note).not.toBeNull();
    if (!note) return;
    expect(note).toContain('qa-loop2.py');
    expect(note).toMatch(/do not create a stand-in/i);
    expect(note).toMatch(/report the path\s+as missing and stop|report the path as missing/i);
    // The create case is answered before the prohibition, so a create-task that
    // slips through the intent check is not pushed toward refusing.
    expect(note.indexOf('CREATE them')).toBeLessThan(note.indexOf('stand-in'));
  });
});
