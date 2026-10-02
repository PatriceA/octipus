import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContext } from '@/core/types';
import { readSkillResource } from './resources';
import { runSkillScript } from './script-runner';
const fixture = vi.hoisted(() => ({ root: '', workspace: '', visible: true, assigned: true, planMode: false, owner: 'u' }));
vi.mock('./registry', () => ({ getSkillRegistry: () => ({ canonicalId: (id: string) => id,
  get: async (id: string, user: string) => fixture.visible && id === 'skill' && user === 'u' ? { id } : undefined,
  getExternalSkills: () => [{ id: 'skill', sources: [{ path: join(fixture.root, 'SKILL.md') }] }],
}) }));
vi.mock('./discovery', () => ({ fetchActiveSkillIdsForTopic: async () => fixture.assigned ? ['skill'] : [] }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => ({
  userId: fixture.owner, context: { devMode: true, projectPath: fixture.workspace, planMode: fixture.planMode },
}) } }));
const context = { id: 'a', userId: 'u', sessionId: 's', role: 'research' } as AgentContext;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'octipus-skill-test-'));
  fixture.root = join(directory, 'bundle'); fixture.workspace = join(directory, 'workspace');
  fixture.visible = true; fixture.assigned = true; fixture.planMode = false; fixture.owner = 'u';
  mkdirSync(join(fixture.root, 'schemas'), { recursive: true }); mkdirSync(fixture.workspace);
  writeFileSync(join(fixture.root, 'SKILL.md'), '# Sample');
  writeFileSync(join(fixture.root, 'schemas', 'common.json'), '{"type":"object"}');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
describe('skill resources', () => {
  it('reads a registered bundle outside the workspace and lists its directories', async () => {
    expect(await readSkillResource('skill', 'schemas/common.json', 'u')).toMatchObject({ content: '{"type":"object"}' });
    expect(await readSkillResource('skill', 'schemas', 'u')).toMatchObject({ entries: [{ name: 'common.json', directory: false }] });
  });
  it('rejects traversal, absolute paths, hidden files, and escaping symlinks', async () => {
    writeFileSync(join(directory, 'secret'), 'private');
    symlinkSync(join(directory, 'secret'), join(fixture.root, 'escape'));
    for (const path of ['../secret', join(directory, 'secret'), '.env', 'escape']) {
      await expect(readSkillResource('skill', path, 'u')).rejects.toThrow();
    }
  });
  it('rejects unavailable skills and cross-user access', async () => {
    await expect(readSkillResource('skill', 'SKILL.md', 'other')).rejects.toThrow('not available');
    fixture.visible = false;
    await expect(readSkillResource('skill', 'SKILL.md', 'u')).rejects.toThrow('not available');
  });
});
describe('assigned skill execution', () => {
  it('requires a role assignment before executing', async () => {
    fixture.assigned = false;
    await expect(runSkillScript('skill', 'run.mjs', [], undefined, context)).rejects.toThrow('assigned');
  });
  it('rejects execution in plan mode and foreign sessions', async () => {
    writeFileSync(join(fixture.root, 'run.mjs'), 'console.log("ok")');
    fixture.planMode = true;
    await expect(runSkillScript('skill', 'run.mjs', [], undefined, context)).rejects.toThrow('plan mode');
    fixture.planMode = false; fixture.owner = 'other';
    await expect(runSkillScript('skill', 'run.mjs', [], undefined, context)).rejects.toThrow('Session not found');
  });
  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('keeps a project-local skill bundle read-only while allowing workspace output', async () => {
    const nested = join(fixture.workspace, 'skill');
    renameSync(fixture.root, nested); fixture.root = nested;
    writeFileSync(join(nested, 'run.mjs'), `
      import fs from 'node:fs';
      let writable = false;
      try { fs.writeFileSync(import.meta.filename, 'bad'); writable = true; } catch {}
      fs.writeFileSync('artifact.txt', 'ok'); console.log(JSON.stringify({ writable }));
    `);
    const result = await runSkillScript('skill', 'run.mjs', [], undefined, context) as any;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ writable: false });
    expect(existsSync(join(fixture.workspace, 'artifact.txt'))).toBe(true);
  });
  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('runs offline with only its workspace writable and no parent credentials', async () => {
    writeFileSync(join(directory, 'secret'), 'outside');
    writeFileSync(join(fixture.root, 'run.mjs'), `
      import fs from 'node:fs';
      import net from 'node:net';
      fs.writeFileSync(process.argv[2], 'artifact');
      let bundleWritable = true; try { fs.writeFileSync(import.meta.filename, 'modified'); } catch { bundleWritable = false; }
      const socket = net.connect(1, '127.0.0.1');
      socket.on('error', () => console.log(JSON.stringify({ bundleWritable, outsideReadable: fs.existsSync(process.argv[3]), secret: process.env.OCTIPUS_AGENT_KEY ?? null, networkConnected: false })));
      socket.on('connect', () => { console.log('unexpected connection'); socket.end(); });
    `);
    const result = await runSkillScript('skill', 'run.mjs', [join(fixture.workspace, 'artifact.txt'), join(directory, 'secret')], undefined, context) as any;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ bundleWritable: false, outsideReadable: false, secret: null, networkConnected: false });
    expect(existsSync(join(fixture.workspace, 'artifact.txt'))).toBe(true);
    expect(existsSync(join(fixture.root, 'schemas/common.json'))).toBe(true);
  });
});
