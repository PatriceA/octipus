import { describe, expect, test } from 'vitest';
import { declarationItems } from '@/shared/plugin-declarations';
import { diffPermissions, permissionsAskSummary } from '@/shared/plugin-permissions';
import { hostCallKind } from './host-api';
import { indexPermissionsSchema } from './index-v2';
import { parseManifest } from './manifest';
import { computePermissions } from './permissions';

const base = {
  name: 'billing', version: '1.0.0', apiVersion: '1.0.0', title: 'Billing', description: 'Invoices at a glance',
  server: { command: 'node', args: ['server.mjs'] },
  tools: { invoices: { effect: 'read' }, totals: { effect: 'read' }, pay: { effect: 'write' } },
  network: ['billing.example.com'],
};
const dashboards = (widgets: Array<Record<string, unknown>>, id = 'main') => [{ id, title: 'Money', widgets }];
const perms = (over: Record<string, unknown> = {}) => computePermissions(parseManifest({ ...base, ...over }));

describe('dashboards in the permissions (docs/PLUGIN-PACKAGES.md#dashboards)', () => {
  const one = perms({ dashboards: dashboards([
    { id: 'open', type: 'stat', title: 'Open', tool: 'totals', input: { status: 'open' }, width: 1, refreshSeconds: 600 },
    { id: 'list', type: 'table', title: 'Invoices', tool: 'invoices' },
  ]) });

  test('right after ui: each widget with its tool and input, in its declared order; none: []', () => {
    const keys = Object.keys(one);
    expect(keys.indexOf('dashboards')).toBe(keys.indexOf('ui') + 1);
    expect(one.dashboards).toEqual([{ id: 'main', title: 'Money', widgets: [
      { id: 'open', type: 'stat', title: 'Open', tool: 'totals', input: { status: 'open' } },
      { id: 'list', type: 'table', title: 'Invoices', tool: 'invoices' },
    ] }]);
    expect(perms().dashboards).toEqual([]);
    // Sorted by id.
    const two = perms({ dashboards: [...dashboards([{ id: 'a', type: 'text', title: 'A', tool: 'invoices' }], 'zeta'), ...dashboards([{ id: 'a', type: 'text', title: 'A', tool: 'invoices' }], 'alpha')] });
    expect(two.dashboards.map((d) => d.id)).toEqual(['alpha', 'zeta']);
  });

  test('the index v2 schema takes them, bounded, and reads an older listing as none', () => {
    expect(indexPermissionsSchema.parse(one).dashboards).toEqual(one.dashboards);
    const { dashboards: _d, ...older } = perms();
    expect(indexPermissionsSchema.parse(older).dashboards).toEqual([]);
    expect(indexPermissionsSchema.safeParse({ ...one, dashboards: [{ ...one.dashboards[0], widgets: [{ ...one.dashboards[0].widgets[0], type: 'html' }] }] }).success).toBe(false);
  });

  test('a new dashboard or a widget fed by another tool or input widens; a removed one does not', () => {
    const none = perms();
    const added = diffPermissions(none, one);
    expect(added.widened).toBe(true);
    expect(added.changes).toContainEqual({ kind: 'dashboards', change: 'added', text: 'dashboard main ("Money"): totals, invoices', widens: true });
    const retooled = perms({ dashboards: dashboards([
      { id: 'open', type: 'stat', title: 'Open', tool: 'totals', input: { status: 'all' } },
      { id: 'list', type: 'table', title: 'Invoices', tool: 'invoices' },
    ]) });
    expect(diffPermissions(one, retooled).widened).toBe(true);
    const relabelled = perms({ dashboards: dashboards([
      { id: 'open', type: 'stat', title: 'Open now', tool: 'totals', input: { status: 'open' } },
      { id: 'list', type: 'table', title: 'Invoices', tool: 'invoices' },
    ]) });
    const label = diffPermissions(one, relabelled);
    expect(label.widened).toBe(false);
    expect(label.changes).toHaveLength(1);
    expect(diffPermissions(one, none).widened).toBe(false);
    // A summary from before dashboards reads as none.
    const { dashboards: _d, ...older } = none;
    expect(diffPermissions(older as typeof none, none).changes).toEqual([]);
  });

  test('in words and as one declaration item per dashboard, naming each widget\'s tool and input', () => {
    expect(permissionsAskSummary(one)).toContain('Adds 1 dashboard: Money');
    const item = declarationItems(one).find((i) => i.id === 'dashboard:main');
    expect(item).toMatchObject({ kind: 'dashboard', label: 'Adds the dashboard "Money"' });
    expect(item?.detail).toBe('Open (stat) ← totals {"status":"open"}; Invoices (table) ← invoices');
    expect(item?.guidance).toContain('no code of the plugin runs in the browser');
  });

  test('a dashboard\'s call is one the user started; nothing else is', () => {
    expect(hostCallKind({ trigger: 'user', sessionId: '', metadata: { source: 'plugin-dashboard' } } as never)).toBe('dashboard');
    expect(hostCallKind({ trigger: 'schedule', sessionId: '', metadata: { source: 'schedule' } } as never)).toBeNull();
  });
});
