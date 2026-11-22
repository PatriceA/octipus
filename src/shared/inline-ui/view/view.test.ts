import { describe, expect, it } from 'vitest';
import {
  applySetAction,
  expandTemplateChildren,
  getPointer,
  healPartialJson,
  INLINE_UI_COMPONENT_NAMES,
  INLINE_UI_VIEW_CATALOG,
  INLINE_UI_VIEW_LIMITS,
  inlineUiViewCatalogPrompt,
  inlineUiViewText,
  isInlineUiViewBody,
  lintInlineUiView,
  normalizeView,
  parseInlineUiViewBody,
  pathProblem,
  resolveDynamic,
  resolveEventAction,
  runViewActions,
  setPointer,
  templateItemLimit,
  validateViewAction,
  validateViewData,
  viewScope,
  viewToAuthored,
  type InlineUiView,
  type InlineUiViewComponentOf,
  type JsonObject,
} from '../index';

const PLANS = {
  data: { usage: 10, choice: null, plans: [{ name: 'S', price: 10 }, { name: 'M', price: 20 }] },
  computed: { extra: 'max(0, usage - 5) * 2' },
  root: {
    component: 'Column',
    children: [
      { component: 'Text', text: 'Pick a plan', variant: 'heading' },
      {
        id: 'list',
        component: 'Row',
        children: {
          path: '/plans',
          template: {
            component: 'Card',
            title: '${name}',
            children: [
              { component: 'Stat', label: 'Price', value: { '@expr': 'price + extra' } },
              { id: 'pick', component: 'Button', label: 'Choose ${name}', action: [{ set: { path: '/choice', value: { '@path': 'name' } } }, { event: { name: 'plan_chosen', context: { plan: { '@path': 'name' }, total: { '@expr': 'price + extra' } }, userMessage: "I'll take ${name}" } }] },
            ],
          },
        },
      },
    ],
  },
};

const lint = (doc: unknown, closed = true) => lintInlineUiView(typeof doc === 'string' ? doc : JSON.stringify(doc), { closed });
const codes = (doc: unknown) => lint(doc).issues.map((i) => i.code);
const messages = (doc: unknown) => lint(doc).issues.map((i) => i.message).join('\n');
const view = (doc: unknown): InlineUiView => {
  const r = lint(doc);
  if (!r.view) throw new Error(`not a view: ${r.issues.map((i) => i.message).join('; ')}`);
  return r.view;
};
const one = (node: unknown): object => ({ root: { component: 'Column', children: [node] } });

describe('view body detection and parsing', () => {
  it('takes a body starting with { as a view', () => {
    expect(isInlineUiViewBody('  \n {"root":1}')).toBe(true);
    expect(isInlineUiViewBody('<div>{</div>')).toBe(false);
  });

  it('reports JSON errors with line and column', () => {
    const r = parseInlineUiViewBody('{\n  "a": 1,\n  "b" 2\n}');
    expect(r).toMatchObject({ ok: false, line: 3, column: 7 });
    expect(lint('{\n  "a": 1,\n  "b" 2\n}').issues[0]).toMatchObject({ code: 'invalid-json', severity: 'fatal', message: expect.stringContaining('line 3, column 7') });
    expect(parseInlineUiViewBody('{"a": ')).toMatchObject({ ok: false, line: 1, column: 7 });
  });
});

describe('normalization', () => {
  it('turns the nested form into an adjacency list with deterministic ids', () => {
    const v = view(PLANS);
    expect(v.root).toBe('root');
    expect(v.components.map((c) => c.id)).toEqual(['root', 'root_0', 'list', 'list_template', 'list_template_0', 'pick']);
    expect(v.components[0]).toMatchObject({ component: 'Column', children: ['root_0', 'list'] });
    expect(v.components[2]).toMatchObject({ children: { path: '/plans', template: 'list_template' } });
    expect(v).toMatchObject({ version: 1, data: PLANS.data, computed: PLANS.computed });
  });

  it('gives the flat A2UI form the same list', () => {
    const flat = {
      data: { n: 1 },
      components: [
        { id: 'root', component: 'Column', children: ['title', 'tabs'] },
        { id: 'title', component: 'Text', text: 'Hi' },
        { id: 'tabs', component: 'Tabs', tabs: [{ title: 'A', child: 'a' }, { title: 'B', child: 'b' }] },
        { id: 'a', component: 'Text', text: 'one' },
        { id: 'b', component: 'Text', text: 'two' },
      ],
    };
    const nested = {
      data: { n: 1 },
      root: {
        component: 'Column',
        children: [
          { id: 'title', component: 'Text', text: 'Hi' },
          { id: 'tabs', component: 'Tabs', tabs: [{ title: 'A', child: { id: 'a', component: 'Text', text: 'one' } }, { title: 'B', child: { id: 'b', component: 'Text', text: 'two' } }] },
        ],
      },
    };
    expect(view(flat)).toEqual(view(nested));
    expect(view(flat).components.map((c) => c.id)).toEqual(['root', 'title', 'tabs', 'a', 'b']);
  });

  it('round-trips through the authored form', () => {
    const v = view(PLANS);
    const authored = viewToAuthored(v);
    expect(authored.root).not.toHaveProperty('id');
    expect(JSON.stringify(authored)).toContain('"id":"pick"');
    expect(view(authored)).toEqual(v);
  });

  it('keeps generated ids clear of written ones', () => {
    const v = view({ root: { component: 'Column', children: [{ component: 'Text', text: 'a' }, { id: 'root_0', component: 'Text', text: 'b' }] } });
    expect(v.components.map((c) => c.id)).toEqual(['root', 'root_0-2', 'root_0']);
    expect(view(viewToAuthored(v))).toEqual(v);
  });

  it('drops unknown props and top-level keys as repairable', () => {
    const r = lint({ version: 2, root: { component: 'Text', text: 'x', color: 'red' } });
    expect(r.view?.components[0]).toEqual({ id: 'root', component: 'Text', text: 'x' });
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([['unknown-key', 'repairable'], ['unknown-prop', 'repairable']]);
    expect(r.issues[1].message).toContain('Text "root" has no prop "color"');
  });

  it('reports structural problems', () => {
    expect(codes({ data: {} })).toEqual(['no-root']);
    expect(codes([1])).toEqual(['not-object']);
    expect(messages(one({ component: 'Foo' }))).toContain('"Foo", which is not in the catalog; use one of Column, Row');
    expect(codes({ components: [{ id: 'root', component: 'Column', children: ['nope'] }] })).toEqual(['unknown-child']);
    expect(codes({ components: [{ id: 'root', component: 'Column', children: ['a'] }, { id: 'a', component: 'Column', children: ['root'] }] })).toEqual(['cycle']);
    expect(codes({ components: [{ id: 'root', component: 'Column', children: ['a', 'a'] }, { id: 'a', component: 'Text', text: 'x' }] })).toEqual(['shared-child']);
    expect(codes({ components: [{ id: 'root', component: 'Column', children: [] }, { id: 'root', component: 'Text', text: 'x' }] })).toContain('duplicate-id');
    expect(codes(one({ id: 'has space', component: 'Text', text: 'x' }))).toContain('bad-id');
    expect(codes({ components: [{ id: 'root', component: 'Text', text: 'x' }, { id: 'lost', component: 'Text', text: 'y' }] })).toEqual(['unused-component']);
    expect(messages({ components: [{ component: 'Divider' }], root: { component: 'Divider' } })).toContain('has no "id"; in the flat form every component needs one');
    expect(codes(one('oops'))).toEqual(['unknown-child']);
    expect(codes(one(7))).toEqual(['bad-node']);
    expect(codes({ data: [], root: { component: 'Divider' } })).toEqual(['bad-data']);
    expect(codes({ computed: { a: 1 }, root: { component: 'Divider' } })).toEqual(['bad-computed']);
    expect(codes(one({ component: 'Row', children: 'x' }))).toEqual(['bad-prop']);
    expect(normalizeView({ root: { component: 'Divider' } }).view?.components).toEqual([{ id: 'root', component: 'Divider' }]);
  });

  it('enforces depth and component count', () => {
    let node: object = { component: 'Text', text: 'deep' };
    for (let i = 0; i < INLINE_UI_VIEW_LIMITS.depth; i++) node = { component: 'Column', children: [node] };
    expect(codes({ root: node })).toEqual(['too-deep']);
    const many = Array.from({ length: INLINE_UI_VIEW_LIMITS.components }, () => ({ component: 'Divider' }));
    expect(codes({ root: { component: 'Column', children: many } })).toEqual(['too-many-components']);
    expect(codes({ root: { component: 'Column', children: many.slice(1) } })).toEqual([]);
  });
});

describe('lint', () => {
  it('accepts a full example without issues', () => {
    expect(lint(PLANS).issues).toEqual([]);
  });

  it('refuses a cut-off or oversized body', () => {
    expect(lint(PLANS, false).issues.map((i) => i.code)).toEqual(['cut-off']);
    const big = JSON.stringify(one({ component: 'Text', text: 'x'.repeat(INLINE_UI_VIEW_LIMITS.bodyChars) }));
    expect(codes(big)).toEqual(['too-large']);
    expect(messages({ data: { s: 'x'.repeat(INLINE_UI_VIEW_LIMITS.dataChars) }, root: { component: 'Divider' } })).toContain('"data" is');
  });

  it('reports missing and mistyped props with what is accepted', () => {
    expect(messages(one({ component: 'Slider', label: 'Qty', value: { '@path': '/q' }, min: 0 }))).toContain('Slider "root_0" needs "max" (a number)');
    expect(messages(one({ component: 'Column', children: [], gap: 'xl' }))).toContain('Column "root_0".gap is "xl"; it takes one of sm, md, lg');
    expect(messages(one({ component: 'Progress', value: 'half' }))).toContain('it takes a number (or {"@path": …} / {"@expr": …})');
    expect(messages(one({ component: 'Row', children: [], wrap: 'yes' }))).toContain('true or false');
    expect(messages(one({ component: 'Table', columns: [{ key: 'a', label: 'A', format: 'money' }], rows: [] }))).toContain('columns[0].format');
    expect(codes(one({ component: 'Table', columns: [{ key: 'a', label: 'A', format: 'currency:EUR' }], rows: [] }))).toEqual([]);
    expect(messages(one({ component: 'Tabs', tabs: [] }))).toContain('is empty; it needs at least one item');
    expect(messages(one({ component: 'Tabs', tabs: [{ child: { component: 'Divider' } }] }))).toContain('tabs[0] needs "title"');
    expect(messages(one({ component: 'Table', columns: [{ key: 'a', label: 'A', width: 3 }], rows: [] }))).toContain('has no key "width"');
  });

  it('allows dynamic values only where the catalog says so', () => {
    expect(messages(one({ component: 'Slider', label: 'x', value: { '@path': '/x' }, min: 0, max: { '@path': '/m' } }))).toContain('Slider "root_0".max is not dynamic');
    // A Slider needs its starting number in data: otherwise it shows min while the answer sends null.
    const slider = (data: JsonObject, path = '/tb') => ({ data, root: { component: 'Slider', label: 'TB', value: { '@path': path }, min: 1, max: 50 } });
    for (const data of [{}, { tb: null }, { tb: '5' }] as JsonObject[]) {
      expect(lint(slider(data)).issues).toContainEqual({ code: 'bad-data', severity: 'fatal', message: 'Slider "root": set an initial number at /tb in data, between min and max (1 to 50)' });
    }
    expect(lint(slider({ tb: 5 })).issues).toEqual([]);
    // A template's relative path is the item's key: not checked.
    expect(lint({ data: { rows: [{}] }, root: { component: 'Column', children: { path: '/rows', template: { component: 'Slider', label: 'n', value: { '@path': 'n' }, min: 0, max: 9 } } } }).issues).toEqual([]);
    expect(messages(one({ component: 'Text', text: { '@path': '/t', extra: 1 } }))).toContain('is not a dynamic value; write exactly');
    expect(codes({ data: { t: 'x' }, root: { component: 'Text', text: { '@path': '/t' }, visible: { '@expr': 't != ""' } } })).toEqual([]);
  });

  it('requires inputs to bind a @path', () => {
    expect(messages(one({ component: 'TextField', label: 'Name', value: '' }))).toContain('TextField "root_0".value must be {"@path": "/key"}');
    expect(codes(one({ component: 'CheckBox', label: 'Ok', value: { '@expr': 'x' } }))).toEqual(['input-binding']);
    expect(codes(one({ component: 'TextField', label: 'Name', value: { '@path': 'name' } }))).toEqual(['bad-path']);
    expect(codes(one({ component: 'TextField', label: 'Name', value: { '@path': '/__proto__/x' } }))).toEqual(['bad-path']);
  });

  it('reports expressions that do not parse, with the expression and position', () => {
    expect(messages(one({ component: 'Text', text: { '@expr': 'price * ' } }))).toContain('Text "root_0".text: the expression "price * " does not parse at position 8');
    expect(messages(one({ component: 'Text', text: 'Total ${a +}' }))).toContain('does not parse at position 11');
    expect(messages({ computed: { a: '1 +' }, root: { component: 'Divider' } })).toContain('computed "a": the expression');
    expect(messages(one({ component: 'Text', text: { '@expr': '$item.name' } }))).toContain('$item in "$item.name" only exists inside a template');
  });

  it('flags names that nothing defines, but not keys an input or action writes', () => {
    expect(lint(one({ component: 'Text', text: '${totl}' })).issues).toMatchObject([{ code: 'unknown-name', severity: 'repairable' }]);
    expect(codes({ root: { component: 'Column', children: [
      { component: 'Text', text: '${name} ${picked}' },
      { component: 'TextField', label: 'Name', value: { '@path': '/name' } },
      { component: 'Button', label: 'Go', action: { set: { path: '/picked', value: true } } },
    ] } })).toEqual([]);
  });

  it('checks computed names and cycles', () => {
    expect(messages({ computed: { a: 'b', b: 'a' }, root: { component: 'Divider' } })).toContain('cycle: a → b → a');
    expect(codes({ computed: { sum: '1' }, root: { component: 'Divider' } })).toEqual(['bad-computed']);
    expect(codes({ computed: { constructor: '1' }, root: { component: 'Divider' } })).toEqual(['bad-computed']);
    const many = Object.fromEntries(Array.from({ length: INLINE_UI_VIEW_LIMITS.computedNames + 1 }, (_, i) => [`c${i}`, '1']));
    expect(codes({ computed: many, root: { component: 'Divider' } })).toEqual(['too-large']);
  });

  it('checks actions, event names and URLs', () => {
    const button = (action: unknown) => one({ component: 'Button', label: 'Go', action });
    expect(messages(button({ event: { name: 'Plan Chosen' } }))).toContain('Button "root_0".action.event.name is "Plan Chosen"');
    expect(codes(button({ go: 1 }))).toEqual(['bad-action']);
    expect(codes(button(Array.from({ length: 5 }, () => ({ openUrl: 'https://example.com' }))))).toEqual(['bad-action']);
    expect(codes(button({ openUrl: 'http://example.com' }))).toEqual(['bad-url']);
    expect(codes(button({ openUrl: 'https://example.com/${id}' }))).toEqual(['unknown-name']);
    expect(codes(button({ set: { path: '/x' } }))).toEqual(['bad-action']);
    expect(codes(button({ set: { path: 'x', value: 1 } }))).toEqual(['bad-path']);
    const context = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(codes(button({ event: { name: 'ok', context } }))).toEqual(['too-large']);
    expect(codes(one({ component: 'Link', text: 'Docs', url: 'javascript:alert(1)' }))).toEqual(['bad-url']);
    expect(codes(button({ event: { name: 'ok', context: { a: 1 }, userMessage: 'Sure', tag: 1 } }))).toEqual(['unknown-prop']);
  });

  it('checks templates: no nesting, lists only, sized to the render budget', () => {
    const inner = { component: 'Column', children: { path: 'tags', template: { component: 'Badge', text: '${$item}' } } };
    expect(codes({ data: { xs: [] }, root: { component: 'Column', children: { path: '/xs', template: inner } } })).toContain('nested-template');
    expect(codes({ data: { xs: 3 }, root: { component: 'Column', children: { path: '/xs', template: { component: 'Divider' } } } })).toEqual(['bad-prop']);
    const items = Array.from({ length: 201 }, (_, i) => i);
    expect(codes({ data: { xs: items }, root: { component: 'Column', children: { path: '/xs', template: { component: 'Divider' } } } })).toEqual(['too-large']);
    const card = { component: 'Card', children: Array.from({ length: 19 }, () => ({ component: 'Divider' })) };
    const r = lint({ data: { xs: Array.from({ length: 101 }, (_, i) => i) }, root: { component: 'Column', children: { path: '/xs', template: card } } });
    expect(r.issues[0].message).toContain('with 20 components per copy the limit is 100');
    expect(codes({ root: { component: 'Column', children: { template: { component: 'Divider' } } } })).toEqual(['bad-prop']);
  });

  it('caps table rows and chart points', () => {
    const rows = Array.from({ length: INLINE_UI_VIEW_LIMITS.tableRows + 1 }, (_, i) => ({ i }));
    expect(codes(one({ component: 'Table', columns: [{ key: 'i', label: 'I' }], rows }))).toEqual(['too-large']);
    expect(codes({ data: { rows }, root: { component: 'Table', columns: [{ key: 'i', label: 'I' }], rows: { '@path': '/rows' } } })).toEqual(['too-large']);
    const points = Array.from({ length: INLINE_UI_VIEW_LIMITS.chartPoints + 1 }, (_, i) => ({ x: i, y: i }));
    expect(codes(one({ component: 'Chart', type: 'line', data: points, x: 'x', series: [{ key: 'y' }] }))).toEqual(['too-large']);
  });

  it('caps the number of issues it reports', () => {
    const r = lint({ root: { component: 'Column', children: Array.from({ length: 30 }, () => ({ component: 'Text' })) } });
    expect(r.issues).toHaveLength(INLINE_UI_VIEW_LIMITS.lintIssues + 1);
    expect(r.issues.at(-1)).toMatchObject({ code: 'more-issues', severity: 'fatal', message: '…and 10 more issues of the same kinds' });
  });
});

describe('data model', () => {
  const data: JsonObject = { a: { b: [10, { c: 'x' }] }, 'k/e~y': 1 };

  it('reads JSON Pointers, escapes included', () => {
    expect(getPointer(data, '/a/b/0')).toBe(10);
    expect(getPointer(data, '/a/b/1/c')).toBe('x');
    expect(getPointer(data, '/k~1e~0y')).toBe(1);
    expect(getPointer(data, '/a/b/2')).toBeUndefined();
    expect(getPointer(data, '/a/b/01')).toBeUndefined();
    expect(getPointer(data, '')).toBe(data);
    expect(() => getPointer(data, 'a')).toThrow(/must start with/);
  });

  it('writes immutably, creating objects and lists on the way', () => {
    const next = setPointer(data, '/a/b/1/c', 'y');
    expect(getPointer(next, '/a/b/1/c')).toBe('y');
    expect(getPointer(data, '/a/b/1/c')).toBe('x');
    expect(next['k/e~y']).toBe(1);
    expect(setPointer({}, '/x/0/y', 1)).toEqual({ x: [{ y: 1 }] });
    expect(setPointer({}, '/x/y', 1)).toEqual({ x: { y: 1 } });
    expect(setPointer({ l: [1] }, '/l/-', 2)).toEqual({ l: [1, 2] });
    expect(setPointer({ l: [] }, '/l/2', 'z')).toEqual({ l: [null, null, 'z'] });
    expect(setPointer({ n: null }, '/n/k', 1)).toEqual({ n: { k: 1 } });
  });

  it('refuses prototype keys, the root and steps through scalars', () => {
    for (const p of ['/__proto__/x', '/a/constructor', '/prototype']) expect(() => setPointer({}, p, 1)).toThrow(/refused key/);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(() => setPointer({}, '', 1)).toThrow(/whole data model/);
    expect(() => setPointer({ s: 'text' }, '/s/x', 1)).toThrow(/holds "text"/);
    expect(() => setPointer({ l: [] }, '/l/x', 1)).toThrow(/not an index/);
    expect(() => setPointer({ l: [] }, '/l/9999', 1)).toThrow(/far past the end/);
    expect(pathProblem('/a/~2', { inTemplate: false })).toContain('"~"');
    expect(pathProblem('name', { inTemplate: true })).toBeNull();
  });

  it('resolves dynamic values, relative paths in a template', () => {
    const scope = { data: { plans: [{ name: 'S' }], qty: 2 }, computed: { double: 'qty * 2' }, item: { name: 'S' }, index: 0, itemPath: '/plans/0' };
    expect(resolveDynamic({ '@path': 'name' }, scope)).toBe('S');
    expect(resolveDynamic({ '@path': '/qty' }, scope)).toBe(2);
    expect(resolveDynamic({ '@path': '/missing' }, scope)).toBeNull();
    expect(resolveDynamic({ '@expr': 'double + $index' }, scope)).toBe(4);
    expect(resolveDynamic('${name} × ${qty}', scope)).toBe('S × 2');
    expect(resolveDynamic([{ '@path': '/qty' }], scope)).toEqual([{ '@path': '/qty' }]);
    expect(() => resolveDynamic({ '@path': 'name' }, { data: {}, computed: {} })).toThrow(/relative/);
  });
});

describe('renderer helpers', () => {
  const v = view(PLANS);
  const list = v.components.find((c) => c.id === 'list') as InlineUiViewComponentOf<'Row'>;
  const pick = v.components.find((c) => c.id === 'pick') as InlineUiViewComponentOf<'Button'>;

  it('expands a template with item scopes', () => {
    const { children, hidden } = expandTemplateChildren(v, list.children, viewScope(v));
    expect(hidden).toBe(0);
    expect(children.map((c) => [c.id, c.key, c.scope.index, c.scope.itemPath])).toEqual([['list_template', 'list_template:0', 0, '/plans/0'], ['list_template', 'list_template:1', 1, '/plans/1']]);
    expect(children[1].scope.item).toEqual({ name: 'M', price: 20 });
    expect(expandTemplateChildren(v, ['a', 'b'], viewScope(v)).children.map((c) => c.key)).toEqual(['a', 'b']);
    expect(expandTemplateChildren(v, { path: '/usage', template: 'x' }, viewScope(v)).children).toEqual([]);
    expect(templateItemLimit(v, 'list_template')).toBe(200);
  });

  it('caps template copies and says how many are hidden', () => {
    const many = view({ data: { xs: [] }, root: { component: 'Column', children: { path: '/xs', template: { component: 'Divider' } } } });
    const root = many.components[0] as InlineUiViewComponentOf<'Column'>;
    const r = expandTemplateChildren(many, root.children, viewScope(many, { xs: Array.from({ length: 250 }, (_, i) => i) }));
    expect(r.children).toHaveLength(200);
    expect(r.hidden).toBe(50);
  });

  it('resolves an event in the clicked copy', () => {
    const item = expandTemplateChildren(v, list.children, viewScope(v)).children[1].scope;
    const step = (pick.action as Array<{ event?: unknown }>)[1] as { event: Parameters<typeof resolveEventAction>[2] };
    expect(resolveEventAction(v, 'pick', step.event, item)).toEqual({ name: 'plan_chosen', context: { plan: 'M', total: 30 }, userMessage: "I'll take M" });
    expect(resolveEventAction(v, 'pick', { name: 'plan_chosen' }, item).userMessage).toBe('Choose M');
    expect(resolveEventAction(v, 'pick', { name: 'x', context: { n: { '@expr': '1 / 0' } }, userMessage: `a${String.fromCharCode(0x202e)}b` }, item)).toEqual({ name: 'x', context: { n: null }, userMessage: 'ab' });
  });

  it('runs actions in order: writes, then the event sees them', () => {
    const item = expandTemplateChildren(v, list.children, viewScope(v)).children[0].scope;
    const { data, effects } = runViewActions(v, 'pick', item);
    expect(data.choice).toBe('S');
    expect(v.data.choice).toBeNull();
    expect(effects).toEqual([{ type: 'event', event: { name: 'plan_chosen', context: { plan: 'S', total: 20 }, userMessage: "I'll take S" } }]);
  });

  it('applies a set step and refuses an unsafe link', () => {
    const scope = viewScope(v);
    expect(applySetAction(v.data, { set: { path: '/usage', value: { '@expr': 'usage + 1' } } }, scope).usage).toBe(11);
    const linky = view({ data: { u: 'javascript:alert(1)' }, root: { id: 'b', component: 'Button', label: 'Go', action: { openUrl: { '@path': '/u' } } } });
    expect(() => runViewActions(linky, 'b', viewScope(linky))).toThrow(/not an https: URL/);
    const ok = view({ root: { id: 'b', component: 'Button', label: 'Go', action: { openUrl: 'https://example.com/a' } } });
    expect(runViewActions(ok, 'b', viewScope(ok)).effects).toEqual([{ type: 'openUrl', url: 'https://example.com/a' }]);
  });

  it('validates an answer against the stored view', () => {
    const base = { blockId: 'b', name: 'plan_chosen', componentId: 'pick', context: { plan: 'M', total: 30 } };
    expect(validateViewAction(v, base)).toBeNull();
    expect(validateViewAction(v, { ...base, componentId: 'nope' })).toContain('no component "nope"');
    expect(validateViewAction(v, { ...base, componentId: 'list' })).toContain('has no event "plan_chosen"');
    expect(validateViewAction(v, { ...base, name: 'other' })).toContain('has no event "other"');
    expect(validateViewAction(v, { ...base, name: 'Bad Name' })).toContain('not valid');
    expect(validateViewAction(v, { ...base, context: { plan: 'M' } })).toContain('missing total');
    expect(validateViewAction(v, { ...base, context: { plan: 'M', total: 1, extra: 1 } })).toContain('not declared: extra');
    expect(validateViewAction(v, { ...base, context: { plan: 'x'.repeat(4_000), total: 1 } })).toContain('limit is 4000');
    expect(validateViewAction(v, { ...base, context: { plan: { a: { b: { c: { d: 1 } } } }, total: 1 } })).toContain('nested 5 levels');
    expect(validateViewAction(v, { ...base, context: [] as unknown as JsonObject })).toContain('JSON object');
    expect(validateViewData({ a: 1 })).toBeNull();
    expect(validateViewData('x')).toContain('JSON object');
    expect(validateViewData({ s: 'x'.repeat(16_000) })).toContain('limit is 16000');
  });
});

describe('text rendering', () => {
  it('writes the plans view as markdown', () => {
    expect(inlineUiViewText(view(PLANS))).toBe([
      '### Pick a plan',
      '**S**',
      'Price: **20**',
      '- Choose S',
      '**M**',
      'Price: **30**',
      '- Choose M',
    ].join('\n\n'));
  });

  it('writes tables, charts, inputs and choices', () => {
    const v = view({
      data: { name: 'Ada', ok: true, qty: 0.5, pick: 'b', rows: [{ item: 'Tea | hot', cost: 3 }, { item: 'Cake', cost: 4.5 }] },
      root: {
        component: 'Column',
        children: [
          { component: 'Table', columns: [{ key: 'item', label: 'Item' }, { key: 'cost', label: 'Cost', align: 'end', format: 'currency:EUR' }], rows: { '@path': '/rows' } },
          { component: 'Chart', type: 'bar', data: { '@path': '/rows' }, x: 'item', series: [{ key: 'cost', label: 'Cost' }] },
          { component: 'KeyValue', items: [{ label: 'Who', value: { '@path': '/name' } }, { label: 'Sum', value: { '@expr': "sum(rows, 'cost')" } }] },
          { component: 'TextField', label: 'Name', value: { '@path': '/name' } },
          { component: 'Slider', label: 'Share', value: { '@path': '/qty' }, min: 0, max: 1, format: 'percent' },
          { component: 'CheckBox', label: 'Agree', value: { '@path': '/ok' } },
          { component: 'ChoicePicker', label: 'Size', options: [{ label: 'Small', value: 'a' }, { label: 'Big', value: 'b' }], value: { '@path': '/pick' } },
          { component: 'Text', text: 'hidden', visible: false },
          { component: 'Link', text: 'Docs', url: 'https://example.com' },
          { component: 'Divider' },
          { component: 'Progress', value: 40, label: 'Done' },
          { component: 'Badge', text: 'new' },
        ],
      },
    });
    expect(inlineUiViewText(v)).toBe([
      '| Item | Cost |\n| --- | --: |\n| Tea \\| hot | €3.00 |\n| Cake | €4.50 |',
      '| item | Cost |\n| --- | --- |\n| Tea \\| hot | 3 |\n| Cake | 4.5 |',
      '- Who: Ada\n- Sum: 7.5',
      'Name: Ada',
      'Share: 50%',
      '- [x] Agree',
      'Size: Big',
      '[Docs](https://example.com)',
      '---',
      'Done: 40 / 100',
      '[new]',
    ].join('\n\n'));
    expect(inlineUiViewText(v, { data: { ...v.data, pick: null, name: '' } })).toContain('Size: one of Small, Big');
    expect(inlineUiViewText(v, { data: { ...v.data, name: '' } })).toContain('Name: —');
  });

  it('shows at most 20 table rows and steps with their titles', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ i }));
    const t = inlineUiViewText(view(one({ component: 'Table', columns: [{ key: 'i', label: 'I' }], rows })));
    expect(t.split('\n').filter((l) => l.startsWith('| ') && /\d/.test(l))).toHaveLength(20);
    expect(t).toContain('_…and 5 more rows_');
    const steps = view({ root: { component: 'Steps', steps: [{ title: 'One', child: { component: 'Text', text: 'a' } }, { title: 'Two', child: { component: 'Text', text: 'b' } }] } });
    expect(inlineUiViewText(steps)).toBe('**Step 1 of 2: One**\n\na\n\n**Step 2 of 2: Two**\n\nb');
  });

  it('shows an expression that fails instead of throwing', () => {
    const v = view({ data: { list: [] }, root: { component: 'Text', text: { '@expr': 'sum(list) + sum(list)' } } });
    // Data grows past what the lint saw, e.g. from an answer's stored state.
    expect(inlineUiViewText(v, { data: { list: Array.from({ length: 6_000 }, (_, i) => i) } })).toContain('⚠ the expression took more than');
  });

  it('shows a date column value past the range of a date as the no-value dash', () => {
    const v = view(one({ component: 'Table', columns: [{ key: 'at', label: 'At', format: 'date' }], rows: [{ at: 9e15 }, { at: -9e15 }, { at: 0 }] }));
    const t = inlineUiViewText(v);
    expect(t).toContain('| — |');
    expect(t).toContain('| Jan 1, 1970 |');
  });
});

describe('partial JSON healing', () => {
  it('closes open strings, lists and objects', () => {
    expect(healPartialJson('{"root": {"component": "Column", "children": [{"component": "Text", "text": "Hel')).toBe('{"root":{"component":"Column","children":[{"component":"Text","text":"Hel"}]}}');
    expect(healPartialJson('{"a": [1, 2')).toBe('{"a":[1,2]}');
    expect(healPartialJson('{"a": {"b": ')).toBe('{"a":{}}');
    expect(healPartialJson('{')).toBe('{}');
  });

  it('drops a trailing incomplete key, literal or number', () => {
    expect(healPartialJson('{"a": 1, "comp')).toBe('{"a":1}');
    expect(healPartialJson('{"a": 1, "b"')).toBe('{"a":1}');
    expect(healPartialJson('{"a": 1, "b": tr')).toBe('{"a":1}');
    expect(healPartialJson('{"a": 1, "b": -')).toBe('{"a":1}');
    expect(healPartialJson('{"a": 1, "b": 2.')).toBe('{"a":1}');
    expect(healPartialJson('{"a": 1,')).toBe('{"a":1}');
    expect(healPartialJson('{"a": "x\\')).toBe('{"a":"x"}');
    expect(healPartialJson('{"a": "x\\u00')).toBe('{"a":"x"}');
    expect(healPartialJson('{"a": "\\u00e9"')).toBe('{"a":"é"}');
  });

  it('returns null when nothing usable is there', () => {
    expect(healPartialJson('')).toBeNull();
    expect(healPartialJson('  <div>')).toBeNull();
    expect(healPartialJson('{"a" 1')).toBeNull();
    expect(healPartialJson('{"a": 1}}')).toBeNull();
    expect(healPartialJson('{"a": [1,]')).toBeNull();
    expect(healPartialJson('['.repeat(100))).toBeNull();
  });

  it('keeps a __proto__ key an own property', () => {
    const healed = healPartialJson('{"__proto__": {"x": 1}, "b": 2');
    expect(healed).toBe('{"__proto__":{"x":1},"b":2}');
  });

  it('heals every prefix of a real view without throwing, and the whole into the view', () => {
    const body = JSON.stringify(PLANS, null, 1);
    for (let i = 0; i <= body.length; i++) healPartialJson(body.slice(0, i));
    expect(JSON.parse(healPartialJson(body) ?? 'null')).toEqual(PLANS);
  });
});

describe('catalog prompt', () => {
  it('mentions every component and stays compact', () => {
    const prompt = inlineUiViewCatalogPrompt();
    for (const name of INLINE_UI_COMPONENT_NAMES) expect(prompt).toMatch(new RegExp(`^${name}\\b`, 'm'));
    expect(prompt.length).toBeLessThanOrEqual(1_500);
    expect(prompt).toContain('Slider(label, value, min, max, step?, format?)');
    expect(prompt).toContain('selected?:@path');
  });

  it('describes the same props the validator checks', () => {
    for (const name of INLINE_UI_COMPONENT_NAMES) {
      const line = inlineUiViewCatalogPrompt().split('\n').find((l) => l === name || l.startsWith(`${name}(`)) ?? '';
      for (const prop of Object.keys(INLINE_UI_VIEW_CATALOG[name].props)) expect(line).toContain(prop);
    }
  });
});
