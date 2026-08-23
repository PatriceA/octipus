/**
 * Workspace snapshots — the filesystem half of the evidence gate.
 *
 * Regression target: a stage that writes through `shell__run` changes real files
 * while `SideEffectCounters.filesChanged` stays 0. These tests use real files
 * rather than mocks, because the whole point of the signal is that it does not
 * trust anything the worker reports.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPILL_DIR } from '@/core/tool-output-spill';
import { countChangedFiles, snapshotWorkspace } from './workspace-snapshot';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-snapshot-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** mtime has finite resolution; rewriting a same-size file within the same tick
 *  can leave the stamp identical. Stage runs take seconds, so nudge the clock
 *  rather than sleeping in the test. */
const touchLater = async (path: string) => {
  const then = new Date(Date.now() + 5_000);
  await utimes(path, then, then);
};

describe('snapshotWorkspace', () => {
  test('records every regular file, and nothing else', async () => {
    await writeFile(join(root, 'dice.py'), 'roll');
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'test_dice.py'), 'assert');

    const snap = await snapshotWorkspace(root);
    expect(snap?.truncated).toBe(false);
    expect([...(snap?.files.keys() ?? [])].sort()).toEqual(['dice.py', join('sub', 'test_dice.py')]);
  });

  test('prunes node_modules and .git — huge, and never a declared artifact', async () => {
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'x');
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), 'ref');
    await writeFile(join(root, 'real.py'), 'y');

    const snap = await snapshotWorkspace(root);
    expect([...(snap?.files.keys() ?? [])]).toEqual(['real.py']);
  });

  test('ignores what RUNNING the code leaves behind', async () => {
    // The false positive this closes: a read-only Code Review stage ran the
    // test suite exactly as instructed, Python wrote __pycache__/*.pyc, and the
    // gate failed it for editing the thing it was reviewing.
    await writeFile(join(root, 'slugify.py'), 'def slugify(): ...');
    const before = await snapshotWorkspace(root);

    await mkdir(join(root, '__pycache__'), { recursive: true });
    await writeFile(join(root, '__pycache__', 'slugify.cpython-314.pyc'), 'bytecode');
    await writeFile(join(root, 'stray.pyc'), 'bytecode');
    await mkdir(join(root, '.pytest_cache'), { recursive: true });
    await writeFile(join(root, '.pytest_cache', 'lastfailed'), '{}');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(0);
  });

  test("ignores what the HARNESS itself leaves behind", async () => {
    // Oversized tool output is spilled into the agent's own workspace, which is
    // the root this snapshot walks. Without the prune a read-only stage that
    // runs one verbose command fails for "changing" a file it never wrote —
    // and a produces-artifacts stage that produced nothing passes on its own
    // spill. Anchored to SPILL_DIR so moving the spill cannot quietly un-prune
    // it: the constant is the contract between the two modules.
    await writeFile(join(root, 'src.ts'), 'export const a = 1;');
    const before = await snapshotWorkspace(root);

    await mkdir(join(root, SPILL_DIR), { recursive: true });
    await writeFile(join(root, SPILL_DIR, 'call-abc.txt'), 'x'.repeat(200));
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(0);
  });

  test('a stage writing real content under .octipus still counts', async () => {
    // The over-correction this closes: pruning the bare name `.octipus`
    // exempted the whole directory, and a project workspace keeps real user
    // content there — this repository keeps its plans under `.octipus/plans/`.
    // A stage asked to write a design document there produced a snapshot of
    // zero changed files, and the evidence gate then failed it for producing
    // nothing. Only the spill path is the harness's.
    const before = await snapshotWorkspace(root);

    await mkdir(join(root, '.octipus', 'plans'), { recursive: true });
    await writeFile(join(root, '.octipus', 'plans', 'design.md'), '# the plan');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(1);
  });

  test('ignores what VERIFYING the packaging leaves behind', async () => {
    // Measured 2026-08-21: a read-only QA stage built a wheel and installed it
    // in a venv to check the package imports — the only way to verify that —
    // and the gate failed it for "changing" the ten files it had generated.
    await writeFile(join(root, 'slugify.py'), 'def slugify(): ...');
    const before = await snapshotWorkspace(root);

    await mkdir(join(root, 'src', 'strkit.egg-info'), { recursive: true });
    await writeFile(join(root, 'src', 'strkit.egg-info', 'PKG-INFO'), 'Name: strkit');
    await writeFile(join(root, 'src', 'strkit.egg-info', 'SOURCES.txt'), 'slugify.py');
    await writeFile(join(root, 'strkit-0.1.0-py3-none-any.whl'), 'zip');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(0);
  });

  test('an sdist beside the source is by-product too, same as its wheel', async () => {
    // `pip wheel .` and `python -m build --sdist --outdir .` differ only in
    // which archive they leave behind; failing one and not the other is one
    // rule applied inconsistently.
    await writeFile(join(root, 'slugify.py'), 'def slugify(): ...');
    const before = await snapshotWorkspace(root);

    await writeFile(join(root, 'strkit-0.1.0.tar.gz'), 'gzip');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(0);
  });

  test('a stage cannot hide arbitrary writes inside a *.egg-info directory', async () => {
    // The subtree used to be pruned wholesale, and the directory name is chosen
    // by whatever the stage runs — so a read-only validator could edit the code
    // it was validating under `anything.egg-info/` and the gate saw nothing.
    await writeFile(join(root, 'slugify.py'), 'v1');
    const before = await snapshotWorkspace(root);

    await mkdir(join(root, 'strkit.egg-info'), { recursive: true });
    await writeFile(join(root, 'strkit.egg-info', 'PKG-INFO'), 'Name: strkit');   // generated, ignored
    await writeFile(join(root, 'strkit.egg-info', 'smuggled.py'), 'payload');     // not, counted
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(1);
  });

  test('overwriting a package that was already there always counts', async () => {
    // The exemption is for a package the stage BUILT on its way to verifying
    // something. A suffix-blind skip let a read-only validator rewrite a
    // checked-in wheel — or drop a `notes.tar.gz` over one — and report nothing.
    await writeFile(join(root, 'vendored-1.0-py3-none-any.whl'), 'original');
    const before = await snapshotWorkspace(root);

    await writeFile(join(root, 'vendored-1.0-py3-none-any.whl'), 'tampered-with-different-length');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(1);
  });

  test('deleting a package always counts', async () => {
    await writeFile(join(root, 'vendored-1.0-py3-none-any.whl'), 'original');
    const before = await snapshotWorkspace(root);
    await rm(join(root, 'vendored-1.0-py3-none-any.whl'));
    const after = await snapshotWorkspace(root);
    expect(countChangedFiles(before, after)).toBe(1);
  });

  test('a package IS counted for a stage that declared it produces artifacts', async () => {
    // The other half of the rule, and the reason it is the caller's decision:
    // hiding the package here would fail a packaging stage for "changing 0
    // files", since a shell-built package raises no tool counter either.
    await writeFile(join(root, 'pyproject.toml'), '[project]');
    const before = await snapshotWorkspace(root);

    // In the workspace ROOT, which the old location rule exempted.
    await writeFile(join(root, 'strkit-0.1.0.tar.gz'), 'gzip');
    await writeFile(join(root, 'strkit-0.1.0-py3-none-any.whl'), 'zip');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after, { countPackages: true })).toBe(2);
  });

  test('a plain archive is not packaging evidence and still counts', async () => {
    await writeFile(join(root, 'slugify.py'), 'v1');
    const before = await snapshotWorkspace(root);
    await writeFile(join(root, 'backup.zip'), 'zip');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(1);
  });

  test('a wheel in dist/ is by-product too when the stage did not declare it', async () => {
    // The location no longer decides. A read-only verification stage that
    // happens to build into `dist/` was previously failed for it.
    await writeFile(join(root, 'pyproject.toml'), '[project]');
    const before = await snapshotWorkspace(root);

    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'strkit-0.1.0-py3-none-any.whl'), 'zip');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(0);
  });

  test('still sees a real edit made in the same run as the caches', async () => {
    await writeFile(join(root, 'slugify.py'), 'v1');
    const before = await snapshotWorkspace(root);
    await mkdir(join(root, '__pycache__'), { recursive: true });
    await writeFile(join(root, '__pycache__', 'x.cpython-314.pyc'), 'bytecode');
    await writeFile(join(root, 'slugify.py'), 'v2 — actually edited');
    await touchLater(join(root, 'slugify.py'));
    const after = await snapshotWorkspace(root);
    expect(countChangedFiles(before, after)).toBe(1);
  });

  test('a root that does not exist yet is EMPTY, not unavailable', async () => {
    // Otherwise the first stage to create the workspace has no baseline, and
    // everything it writes goes unmeasured.
    const snap = await snapshotWorkspace(join(root, 'not-created-yet'));
    expect(snap).not.toBeNull();
    expect(snap?.files.size).toBe(0);
    expect(snap?.truncated).toBe(false);
  });

  test('marks truncated past the file cap rather than diffing a partial tree', async () => {
    for (const n of ['a', 'b', 'c']) await writeFile(join(root, n), n);
    const snap = await snapshotWorkspace(root, { maxFiles: 2 });
    expect(snap?.truncated).toBe(true);
  });
});

describe('countChangedFiles', () => {
  test('counts a file written through the shell', async () => {
    await writeFile(join(root, 'dice.py'), 'def roll(n, sides): ...');
    const before = await snapshotWorkspace(root);

    // What `shell__run` with a heredoc does, as far as the disk is concerned.
    await writeFile(join(root, 'dice.py'), 'def roll(n, sides, seed=None): ...');
    await touchLater(join(root, 'dice.py'));
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(1);
  });

  test('counts creations and deletions', async () => {
    await writeFile(join(root, 'gone.py'), 'x');
    const before = await snapshotWorkspace(root);

    await rm(join(root, 'gone.py'));
    await writeFile(join(root, 'new.py'), 'y');
    const after = await snapshotWorkspace(root);

    expect(countChangedFiles(before, after)).toBe(2);
  });

  test('an untouched workspace counts zero — the gate must still be able to bite', async () => {
    await writeFile(join(root, 'dice.py'), 'unchanged');
    const before = await snapshotWorkspace(root);
    const after = await snapshotWorkspace(root);
    expect(countChangedFiles(before, after)).toBe(0);
  });

  test('a same-size rewrite is caught by mtime', async () => {
    await writeFile(join(root, 'flag.txt'), 'AAAA');
    const before = await snapshotWorkspace(root);
    await writeFile(join(root, 'flag.txt'), 'BBBB');
    await touchLater(join(root, 'flag.txt'));
    const after = await snapshotWorkspace(root);
    expect(countChangedFiles(before, after)).toBe(1);
  });

  test('returns null — never 0 — when either side is missing or truncated', async () => {
    // null means "no evidence"; 0 means "evidence of nothing". Conflating them
    // would let an unreadable workspace fail a stage that did real work.
    const snap = await snapshotWorkspace(root);
    expect(countChangedFiles(null, snap)).toBeNull();
    expect(countChangedFiles(snap, null)).toBeNull();
    expect(countChangedFiles({ files: new Map(), truncated: true }, snap)).toBeNull();
    expect(countChangedFiles(snap, { files: new Map(), truncated: true })).toBeNull();
  });
});
