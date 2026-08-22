import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFS } from '@/security/workspace-fs';
import { SPILL_DIR, previewFor, spillToolOutput } from './tool-output-spill';

const bigText = (n: number): string => 'A'.repeat(n - 3) + 'END';

describe('spillToolOutput', () => {
  test('leaves an output under the threshold alone', async () => {
    expect(await spillToolOutput('small', { toolCallId: 'c1', threshold: 100 })).toBeNull();
  });

  test('saves the FULL text and hands back a head, a tail and the path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'));
    const fs = WorkspaceFS.withRoot(root);
    const text = bigText(60_000);

    const preview = await spillToolOutput(text, { toolCallId: 'call_42', threshold: 50_000, fs });

    expect(preview).not.toBeNull();
    // Verify the world, not the self-report: read the file back rather than
    // trusting the returned string, and check nothing was lost on the way.
    const saved = readFileSync(join(root, SPILL_DIR, 'call_42.txt'), 'utf8');
    expect(saved).toBe(text);
    expect(saved.length).toBe(60_000);
    // The point of the tail: an output's last lines (the error, the summary)
    // are what a fragment cut from the front always loses.
    expect(preview!.endsWith('END')).toBe(true);
    expect(preview!).toContain(`${SPILL_DIR}/call_42.txt`);
    expect(preview!.length).toBeLessThan(6_000);
    // Owner-only, whatever the umask says.
    expect(statSync(join(root, SPILL_DIR, 'call_42.txt')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, SPILL_DIR)).mode & 0o777).toBe(0o700);
  });

  test('a provider-shaped id cannot escape the spill directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'));
    const fs = WorkspaceFS.withRoot(root);
    const preview = await spillToolOutput(bigText(60_000), {
      toolCallId: '../../etc/passwd',
      threshold: 50_000,
      fs,
    });
    expect(preview).toContain(`${SPILL_DIR}/etcpasswd.txt`);
    expect(readFileSync(join(root, SPILL_DIR, 'etcpasswd.txt'), 'utf8').length).toBe(60_000);
  });

  test('a failed save falls back to plain truncation rather than to an error', async () => {
    const broken = {
      resolve() {
        throw new Error('workspace unavailable');
      },
    } as unknown as WorkspaceFS;
    expect(
      await spillToolOutput(bigText(60_000), { toolCallId: 'c2', threshold: 50_000, fs: broken }),
    ).toBeNull();
  });
});

describe('previewFor', () => {
  test('states the exact size, so the model can judge whether to go and read it', () => {
    const p = previewFor('x'.repeat(10_000), '.octipus/tool-output/a.txt');
    expect(p).toContain('of 10000 characters omitted');
  });
});
