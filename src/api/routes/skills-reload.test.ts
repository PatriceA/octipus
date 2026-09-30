import { beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '@/api/http';
import { principalFromUser } from '@/security/principal';
import { SkillRegistry } from '@/skills/registry';
import { skillRoutes } from './skills';

const fixture = vi.hoisted(() => ({
  user: { id: 'user', username: 'user', isAdmin: false } as { id: string; username: string; isAdmin: boolean } | null,
  registry: null as SkillRegistry | null, root: '', fail: false,
}));
vi.mock('@/api/context', async () => ({
  apiContext: new (await import('@/api/http')).App().derive(() => ({
    user: fixture.user, principal: fixture.user ? principalFromUser(fixture.user) : { kind: 'anonymous' },
  })),
}));
vi.mock('@/skills/registry', async importOriginal => ({
  ...await importOriginal<typeof import('@/skills/registry')>(), getSkillRegistry: () => fixture.registry!,
}));
vi.mock('@/skills/external-loader', async importOriginal => {
  const actual = await importOriginal<typeof import('@/skills/external-loader')>();
  return { ...actual, loadExternalSkills: () => {
    if (fixture.fail) throw new Error('private filesystem failure');
    return actual.loadExternalSkills({ home: fixture.root, cwd: fixture.root, configuredDirs: [], enabled: true });
  } };
});
const app = new App().use(skillRoutes);
const request = () => app.handle(new Request('http://test/skills/reload-mounted', { method: 'POST' }));
let source: string;
beforeEach(() => {
  fixture.user = { id: 'user', username: 'user', isAdmin: false };
  fixture.fail = false;
  fixture.root = mkdtempSync(join(tmpdir(), 'octipus-reload-test-'));
  const directory = join(fixture.root, '.claude', 'skills', 'sample');
  mkdirSync(directory, { recursive: true });
  source = join(directory, 'SKILL.md');
  writeFileSync(source, '---\nname: Sample\ndescription: Sample skill\n---\nOriginal instructions');
  fixture.registry = new SkillRegistry();
  fixture.registry.loadExternal();
});

test('manual reload sees changed and removed sources, keeping stable skill IDs', async () => {
  const before = fixture.registry!.getExternalSkills()[0];
  writeFileSync(source, '---\nname: Sample\ndescription: Sample skill\n---\nUpdated instructions');
  expect((await fixture.registry!.get(before.id))?.content).toContain('Original instructions');
  expect((await request()).status).toBe(200);
  expect((await fixture.registry!.get(before.id))?.content).toContain('Updated instructions');
  unlinkSync(source);
  expect((await request()).status).toBe(200);
  expect(fixture.registry!.getExternalSkills()).toEqual([]);
});

test('failed reload reports an error without discarding the loaded snapshot or leaking paths', async () => {
  fixture.fail = true;
  const response = await request();
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('private filesystem');
  expect(fixture.registry!.getExternalSkills()[0].content).toContain('Original instructions');
});

test('unauthenticated requests cannot trigger a scan', async () => {
  fixture.user = null;
  const scan = vi.spyOn(fixture.registry!, 'reloadExternal');
  expect((await request()).status).toBe(401);
  expect(scan).not.toHaveBeenCalled();
});
