/**
 * Task 8: octipus compacts its own copy of a session's history, but the
 * vendor CLI (when reuse is on) still holds the full transcript in its own
 * session. `compactVendorSession` pushes that compaction down: Claude Code
 * can be compacted non-interactively (`/compact` expands in print mode), so
 * we resume its session and send it. Codex cannot (interactive-only), so we
 * rotate — drop the stored thread id so the next turn starts cold, seeded by
 * octipus's own summary.
 *
 * Spawn-stubbing pattern lifted from cli-agent-resume.test.ts: `spawn` is
 * mocked to launch a small Node script standing in for the real `claude`
 * binary, and the fake binary dumps the argv it was given so the test can
 * assert on the real args `execCli` built (not a value handed to the test
 * directly).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '@/db/schema/sessions';

const fixture = vi.hoisted(() => ({
  script: '',
  dir: '',
  sessions: new Map<string, { id: string; userId: string; context: SessionContext }>(),
}));

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (binary: string, args: string[], opts: object) => {
      if (binary !== 'claude') throw new Error(`Unexpected CLI invocation: ${binary}`);
      const shell = (opts as { shell?: boolean }).shell === true;
      const quote = (p: string) => (shell && /\s/.test(p) ? `"${p}"` : p);
      return actual.spawn(quote(process.execPath), [quote(fixture.script), ...args], opts);
    },
  };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (binary: string, args: string[], opts: object) => {
      if (binary !== 'claude') throw new Error(`Unexpected CLI invocation: ${binary}`);
      const shell = (opts as { shell?: boolean }).shell === true;
      const quote = (p: string) => (shell && /\s/.test(p) ? `"${p}"` : p);
      return actual.spawn(quote(process.execPath), [quote(fixture.script), ...args], opts);
    },
  };
});
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: {
    findById: async (id: string) => {
      const row = fixture.sessions.get(id);
      return row ? { ...row } : undefined;
    },
    setContextKey: async (id: string, path: string[], value: unknown) => {
      const row = fixture.sessions.get(id);
      if (!row) return;
      let node = row.context as Record<string, unknown>;
      for (const seg of path.slice(0, -1)) {
        if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
        node = node[seg] as Record<string, unknown>;
      }
      const leaf = path[path.length - 1];
      if (value === undefined) delete node[leaf];
      else node[leaf] = value;
    },
    update: async (id: string, data: { context?: SessionContext }) => {
      const row = fixture.sessions.get(id);
      if (!row) return null;
      if (data.context !== undefined) row.context = data.context;
      return { ...row };
    },
  },
}));

import { compactVendorSession } from './cli-session-compact';
import { loadCliSession, saveCliSession } from './cli-session-store';

function makeSession(sessionId: string) {
  fixture.sessions.set(sessionId, { id: sessionId, userId: 'u', context: {} as SessionContext });
}

// What actually reached `claude` — the real argv `execCli` built, dumped by
// the fake binary, not a value the test handed itself.
const lastRun = (): { args: string[]; cwd: string } => JSON.parse(readFileSync(join(fixture.dir, 'claude-last-args.json'), 'utf-8'));
const lastArgs = (): string[] => lastRun().args;

beforeEach(() => {
  fixture.dir = mkdtempSync(join(tmpdir(), 'octipus-cli-compact-'));
  fixture.script = join(fixture.dir, 'fake-claude.mjs');
  fixture.sessions = new Map();
  const argsFile = join(fixture.dir, 'claude-last-args.json');
  writeFileSync(fixture.script, `
    import { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, cwd: process.cwd() }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'compacted' }));
  `);
});

afterEach(() => { rmSync(fixture.dir, { recursive: true, force: true }); });

describe('compactVendorSession', () => {
  it('sends /compact to a live Claude session', async () => {
    makeSession('s1');
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp', lastUsedAt: new Date().toISOString() });

    const result = await compactVendorSession('s1', 'Claude Code', 'focus on the migration');

    expect(result).toBe('compacted');
    const args = lastArgs();
    expect(args).toContain('--resume');
    expect(args[args.length - 1]).toBe('/compact focus on the migration');
  });

  it('I5 — resumes from the session workspace, where Claude indexed the session', async () => {
    // Claude indexes sessions BY PROJECT DIRECTORY. `execCli` hardcoded
    // `resolveWorkspaceRoot()`, while the agent that created the session ran
    // with `resolve(WorkspaceFS.forSession(session).root)` — so the resume
    // found no such session, the error was swallowed as non-fatal, and the log
    // claimed the compaction pass had run.
    makeSession('s1');
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp', lastUsedAt: new Date().toISOString() });

    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const expected = resolve(WorkspaceFS.forSession(fixture.sessions.get('s1')!).root);
    mkdirSync(expected, { recursive: true });

    expect(await compactVendorSession('s1', 'Claude Code')).toBe('compacted');
    expect(resolve(lastRun().cwd)).toBe(expected);
  });

  it('rotates a Codex thread, which cannot be compacted non-interactively', async () => {
    makeSession('s1');
    await saveCliSession('s1', 'Codex CLI', { id: 't1', fingerprint: 'fp', lastUsedAt: new Date().toISOString() });

    expect(await compactVendorSession('s1', 'Codex CLI')).toBe('rotated');
    expect(await loadCliSession('s1', 'Codex CLI', 'fp')).toBeNull();
  });

  it('skips when there is no live vendor session', async () => {
    makeSession('s-none');
    expect(await compactVendorSession('s-none', 'Claude Code')).toBe('skipped');
  });

  it('skips for an adapter that never participates in vendor session reuse', async () => {
    makeSession('s1');
    expect(await compactVendorSession('s1', 'Antigravity')).toBe('skipped');
  });
});
