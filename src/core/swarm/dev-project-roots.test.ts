import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionRepository } from '@/db/repositories/session-repository';
import { premiseNoteFor } from '@/core/premise';
import { runScorers } from './scorers';
import { premiseRootsFor } from './spawner';

/**
 * A dev-mode child runs IN its project (CLI cwd, `shell__run`), so a brief or a
 * scorer naming `sidecar/tests/ui/oracle.test.ts` means that project's file.
 *
 * Measured: a QA child in a session pinned to `…/BPMN Editor` was told by the
 * premise check that `sidecar/tests/ui/oracle.test.ts` did not exist and to
 * stop — the check only looked in the per-user sandbox. The directory name has
 * a space on purpose; the real one does.
 */
let project: string;

beforeAll(() => {
  project = join(mkdtempSync(join(tmpdir(), 'octi-devroot-')), 'BPMN Editor');
  mkdirSync(join(project, 'sidecar', 'tests', 'ui'), { recursive: true });
  writeFileSync(join(project, 'sidecar', 'tests', 'ui', 'oracle.test.ts'), '// oracle');
  vi.spyOn(sessionRepository, 'findById').mockResolvedValue({
    id: 's1',
    context: { devMode: true, projectPath: project },
  } as never);
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(join(project, '..'), { recursive: true, force: true });
});

describe('dev-mode project roots', () => {
  it('premise check resolves a relative path against the session project', async () => {
    const roots = await premiseRootsFor('u1', 's1');
    expect(roots[0]).toBe(project);
    const brief = 'Run sidecar/tests/ui/oracle.test.ts and fix failures in sidecar/tests/ui/nope.test.ts';
    const note = premiseNoteFor(brief, roots);
    expect(note).toContain('sidecar/tests/ui/nope.test.ts');
    expect(note).not.toContain('oracle.test.ts');
  });

  it('no session project → sandbox only (old behaviour)', async () => {
    vi.mocked(sessionRepository.findById).mockResolvedValueOnce({ id: 's2', context: {} } as never);
    const roots = await premiseRootsFor('u1', 's2');
    expect(roots).not.toContain(project);
  });

  it('file_exists scorer resolves against the project path', async () => {
    const ok = await runScorers(
      [{ kind: 'file_exists', path: 'sidecar/tests/ui/oracle.test.ts' }],
      { output: 'x' },
      { userId: 'system', projectPath: project },
    );
    expect(ok.passed).toBe(true);
    const missing = await runScorers(
      [{ kind: 'file_exists', path: 'sidecar/tests/ui/nope.test.ts' }],
      { output: 'x' },
      { userId: 'system', projectPath: project },
    );
    expect(missing.passed).toBe(false);
  });
});
