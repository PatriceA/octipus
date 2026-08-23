import { describe, expect, test } from 'vitest';
import { WorkspaceFS } from '@/security/workspace-fs';
import { ShellTool } from './index';

// `shell__run` used to default to the FLAT `config.workspace.rootPath` while
// every `filesystem__*` call was sandboxed to the per-user nested root two
// levels below it. Measured cost, 2026-08-07: an Implementation stage made 27
// tool calls, ran 13 commands and committed, and the evidence gate recorded
// `filesChanged: 0, filesTouched: 0` — the work had gone somewhere the
// workspace snapshot does not look, so the stage was failed for doing nothing.
const cwdFor = (context?: { userId?: string }) =>
  (new ShellTool() as unknown as { getWorkspaceRoot(c?: { userId?: string }): string }).getWorkspaceRoot(context);

describe('shell default cwd', () => {
  test('is the same root the filesystem sandbox enforces for a real user', () => {
    const userId = '11111111-2222-3333-4444-555555555555';
    expect(cwdFor({ userId })).toBe(WorkspaceFS.forAgent({ userId }).root);
  });

  test("a real user's cwd is nested under the flat root, not equal to it", () => {
    // The regression itself: if these ever compare equal again, the nesting has
    // been lost and shell has drifted away from filesystem a second time.
    const userId = '11111111-2222-3333-4444-555555555555';
    expect(cwdFor({ userId })).not.toBe(cwdFor());
    expect(cwdFor({ userId }).startsWith(cwdFor())).toBe(true);
  });

  test('system contexts keep the flat root — unchanged behaviour', () => {
    for (const userId of [undefined, 'system', 'local']) {
      expect(cwdFor(userId ? { userId } : undefined)).toBe(WorkspaceFS.forAgent({ userId }).root);
    }
  });
});
