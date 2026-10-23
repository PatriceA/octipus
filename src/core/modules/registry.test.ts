/**
 * The module registry (docs/MODULES.md): what counts as on, how turning one
 * on or off follows the dependencies, and that every route, tool, job and
 * case entity a module names belongs to it alone.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { discoverTools } from '@/tools/discovery';

const state = vi.hoisted(() => ({ enabled: [] as unknown }));
vi.mock('@/config', () => ({ getConfig: () => ({ modules: { enabled: state.enabled } }) }));
vi.mock('@/modules', async () => {
  const real = await vi.importActual<typeof import('@/modules')>('@/modules');
  const extra = [
    { id: 'base', title: 'Base', description: '', profiles: [], dependsOn: [], routes: ['/api/base'], pages: [], tools: [], jobs: ['base-job'], caseEntities: [] },
    { id: 'top', title: 'Top', description: '', profiles: [], dependsOn: ['base'], routes: ['/api/top'], pages: [], tools: ['top-tool'], jobs: [], caseEntities: ['top-thing'] },
  ];
  return { MODULES: [...real.MODULES, ...extra], REAL_MODULES: real.MODULES };
});

const registry = await import('./registry');
const { REAL_MODULES } = (await import('@/modules')) as unknown as { REAL_MODULES: typeof import('@/modules').MODULES };

beforeEach(() => { state.enabled = []; });

describe('what is on', () => {
  test('nothing listed: the core only', () => {
    expect(registry.enabledModules().size).toBe(0);
    expect(registry.isModuleOn('business')).toBe(false);
    expect(registry.isToolOn('cases')).toBe(false);
    expect(registry.isToolOn('notes')).toBe(true);
    expect(registry.isPathOn('/api/cases/123')).toBe(false);
    expect(registry.isPathOn('/api/cases')).toBe(false);
    expect(registry.isPathOn('/api/casesx')).toBe(true);
    expect(registry.isPathOn('/api/notes')).toBe(true);
    expect(registry.isJobOn('mail-sync')).toBe(false);
    expect(registry.isJobOn('reminders')).toBe(true);
    expect(registry.isCaseEntityOn('mail')).toBe(false);
    expect(registry.isCaseEntityOn('document')).toBe(true);
  });

  test('listed modules are on; unknown ids and a non-array are ignored', () => {
    state.enabled = ['business', 'nope'];
    expect([...registry.enabledModules()]).toEqual(['business']);
    expect(registry.isToolOn('cases')).toBe(true);
    expect(registry.isPathOn('/api/forms/abc')).toBe(true);
    expect(registry.isToolOn('mail')).toBe(false);
    state.enabled = 'business';
    expect(registry.enabledModules().size).toBe(0);
  });

  test('a module whose dependency is off is off, whatever the setting says', () => {
    state.enabled = ['top'];
    expect(registry.isModuleOn('top')).toBe(false);
    expect(registry.isToolOn('top-tool')).toBe(false);
    expect(registry.isCaseEntityOn('top-thing')).toBe(false);
    state.enabled = ['top', 'base'];
    expect(registry.isModuleOn('top')).toBe(true);
  });
});

describe('turning modules on and off', () => {
  test('on brings what it depends on', () => {
    expect(registry.nextEnabled([], 'top', true)).toEqual(['base', 'top']);
  });

  test('off is refused while a module that depends on it is on', () => {
    expect(() => registry.nextEnabled(['base', 'top'], 'base', false)).toThrow(registry.ModuleChangeError);
    expect(registry.nextEnabled(['base', 'top'], 'top', false)).toEqual(['base']);
    expect(registry.nextEnabled(['base'], 'base', false)).toEqual([]);
  });

  test('unknown ids are refused; ids this build does not declare are kept, after the declared ones', () => {
    expect(() => registry.nextEnabled([], 'nope', true)).toThrow(/Unknown module/);
    // A module of a later version stays as its migration left it.
    expect(registry.nextEnabled(['later', 'protection'], 'business', true)).toEqual(['business', 'protection', 'later']);
    expect(registry.nextEnabled(['later', 'protection'], 'protection', false)).toEqual(['later']);
  });

  test('the views say what needs what', () => {
    state.enabled = ['base', 'top'];
    const base = registry.moduleViews().find((m) => m.id === 'base');
    expect(base).toMatchObject({ on: true, requiredBy: ['top'], jobs: ['base-job'] });
  });
});

describe('the declarations', () => {
  const modules = REAL_MODULES;

  test('ids are unique and dependencies exist', () => {
    const ids = modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of modules) for (const dep of m.dependsOn) expect(ids, `${m.id} depends on ${dep}`).toContain(dep);
  });

  test('a route, tool, job, page or case entity belongs to one module', () => {
    for (const field of ['routes', 'tools', 'jobs', 'pages', 'caseEntities'] as const) {
      const all = modules.flatMap((m) => m[field]);
      expect(new Set(all).size, field).toBe(all.length);
    }
    const prefixes = modules.flatMap((m) => m.routes);
    for (const a of prefixes) for (const b of prefixes) if (a !== b) expect(a.startsWith(`${b}/`), `${a} is under ${b}`).toBe(false);
  });

  test('every tool a module names exists', async () => {
    const ids = new Set((await discoverTools()).map((t) => t.tool.id));
    for (const m of modules) for (const tool of m.tools) expect(ids, `${m.id}: ${tool}`).toContain(tool);
  });

  test('every route prefix is under /api or a mounted page path', () => {
    for (const m of modules) for (const route of m.routes) expect(route).toMatch(/^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/);
  });
});
