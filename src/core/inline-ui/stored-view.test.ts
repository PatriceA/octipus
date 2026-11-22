/**
 * A view from another install (`room.inline_ui`) is rendered by this
 * install's components only when it is a view this install would have
 * stored; anything else refuses the whole answer (federation: never patched up).
 */
import { describe, expect, it } from 'vitest';
import { parseHostAnswer } from '@/core/federation/host-answers';
import { lintInlineUiView } from '@/shared/inline-ui';
import { storedViewProblem } from './stored-view';

const stored = lintInlineUiView(JSON.stringify({
  data: { n: 2 },
  root: { component: 'Column', children: [{ component: 'Stat', label: 'N', value: { '@path': '/n' } }] },
}), { closed: true }).view!;

const block = (over: Record<string, unknown>) => ({
  block: {
    id: '11111111-1111-4111-8111-111111111111', title: 'T', heightHint: 320, css: '', html: '', js: '',
    scripts: false, tainted: false, risk: 'normal', issues: [], createdAt: '2026-11-22T00:00:00.000Z', ...over,
  },
});

describe('storedViewProblem', () => {
  it('accepts a stored view and refuses anything else', () => {
    expect(storedViewProblem(stored)).toBeNull();
    expect(storedViewProblem(null)).toMatch(/not a JSON object/);
    expect(storedViewProblem({ version: 1, root: 'root', components: 'nope', data: {}, computed: {} })).toMatch(/not a stored view/);
    const unknown = { ...stored, components: [{ ...stored.components[0], component: 'Carousel' }, ...stored.components.slice(1)] };
    expect(storedViewProblem(unknown)).not.toBeNull();
    const extraProp = { ...stored, components: [{ ...stored.components[0], onClick: 'x' }, ...stored.components.slice(1)] };
    expect(storedViewProblem(extraProp)).toMatch(/normalized form/);
  });
});

describe("a host's room.inline_ui answer", () => {
  it('passes an HTML block from a host without views, and a valid view with its answer', () => {
    expect(() => parseHostAnswer('room.inline_ui', block({}))).not.toThrow();
    expect(() => parseHostAnswer('room.inline_ui', block({
      kind: 'view', view: stored, state: { data: { n: 3 }, action: { name: 'go', componentId: 'root', at: '2026-11-22T00:00:00.000Z' } },
    }))).not.toThrow();
  });

  it('refuses a view that is not one this install would store, or answer data over the limit', () => {
    expect(() => parseHostAnswer('room.inline_ui', block({ kind: 'view', view: { root: 'x' } }))).toThrow();
    expect(() => parseHostAnswer('room.inline_ui', block({
      kind: 'view', view: stored, state: { data: { blob: 'x'.repeat(16_001) }, action: { name: 'go', componentId: 'root', at: 'now' } },
    }))).toThrow(/limit is 16000/);
  });
});
