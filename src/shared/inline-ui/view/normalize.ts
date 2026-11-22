/**
 * From the JSON an agent writes to the stored view and back
 * (docs/plans/inline-ui-views-spec.md §2.2–2.3).
 *
 * `normalizeView` checks structure only — the document shape, components,
 * ids, children, cycles, depth and count, unknown props — and builds the
 * adjacency list. Prop values are checked by `lintInlineUiView`, which calls
 * it; use the lint unless the document was already linted.
 */
import { INLINE_UI_VIEW_LIMITS } from '../limits';
import type { InlineUiIssue } from '../lint';
import { INLINE_UI_COMPONENT_NAMES, INLINE_UI_VIEW_CATALOG, inlineUiPropSpec, isInlineUiComponentName } from './catalog';
import { isJsonObject } from './json';
import type { AuthoredNode, AuthoredView, InlineUiView, InlineUiViewComponent, JsonObject, JsonValue } from './types';

/** Whether a fence body is a view (first non-blank character `{`) rather than an HTML block. */
export function isInlineUiViewBody(body: string): boolean {
  return body.trimStart().startsWith('{');
}

export type ParsedViewBody =
  | { ok: true; doc: unknown }
  | { ok: false; message: string; line?: number; column?: number };

function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

/**
 * `JSON.parse` with the place of a syntax error as 1-based line and column.
 * Engines word the error differently; V8 (the server) gives a position.
 */
export function parseInlineUiViewBody(body: string): ParsedViewBody {
  try {
    return { ok: true, doc: JSON.parse(body) };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const raw = err.message;
    const message = raw.replace(/\s*(?:in JSON\s*)?at position \d+.*$/s, '').replace(/^JSON\.parse:\s*/, '') || 'invalid JSON';
    const position = /at position (\d+)/.exec(raw);
    if (position) return { ok: false, message, ...lineColumn(body, Number(position[1])) };
    const lc = /line (\d+) column (\d+)/.exec(raw);
    if (lc) return { ok: false, message, line: Number(lc[1]), column: Number(lc[2]) };
    if (/end of (?:JSON )?(?:input|data)/i.test(raw)) return { ok: false, message, ...lineColumn(body, body.length) };
    return { ok: false, message };
  }
}

export const INLINE_UI_VIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOP_LEVEL_KEYS = new Set(['data', 'computed', 'root', 'components']);

export interface NormalizeResult {
  /** Present when no issue is fatal. Prop values are not checked yet. */
  view?: InlineUiView;
  issues: InlineUiIssue[];
}

const fatal = (code: string, message: string): InlineUiIssue => ({ code, severity: 'fatal', message });
const repairable = (code: string, message: string): InlineUiIssue => ({ code, severity: 'repairable', message });

/** The ids a node's children get when the author gave none (also used by `viewToAuthored`). */
const childIdCandidate = (parentId: string, index: number): string => `${parentId}_${index}`;
const templateIdCandidate = (parentId: string): string => `${parentId}_template`;

/** The props of a component that hold children, by kind. */
function childProps(component: keyof typeof INLINE_UI_VIEW_CATALOG): Array<{ prop: string; kind: 'children' | 'objects'; field?: string }> {
  const out: Array<{ prop: string; kind: 'children' | 'objects'; field?: string }> = [];
  for (const [prop, spec] of Object.entries(INLINE_UI_VIEW_CATALOG[component].props)) {
    if (spec.kind === 'children') out.push({ prop, kind: 'children' });
    const field = spec.kind === 'objects' && spec.fields ? Object.entries(spec.fields).find(([, f]) => f.kind === 'child')?.[0] : undefined;
    if (field) out.push({ prop, kind: 'objects', field });
  }
  return out;
}

class Normalizer {
  readonly issues: InlineUiIssue[] = [];
  readonly components: InlineUiViewComponent[] = [];
  /** Nodes listed in `components` and nested nodes with an id, by id. */
  private readonly pool = new Map<string, Record<string, unknown>>();
  /** Every id in the document or already generated: generated ids avoid them. */
  private readonly taken = new Set<string>();
  private readonly placed = new Set<Record<string, unknown>>();
  private readonly stack = new Set<Record<string, unknown>>();
  private readonly ids = new Map<Record<string, unknown>, string>();
  private tooDeep = false;
  private tooMany = false;

  issue(i: InlineUiIssue): void { this.issues.push(i); }

  /** Register explicit ids before the walk, so generated ones never collide with an id written later in the document. */
  collect(node: unknown, depth: number, fromList: boolean): void {
    if (!isJsonObject(node) || depth > INLINE_UI_VIEW_LIMITS.depth + 1) return;
    const id = node.id;
    if (id !== undefined) {
      if (typeof id !== 'string' || !INLINE_UI_VIEW_ID_RE.test(id)) {
        this.issue(fatal('bad-id', `component id ${JSON.stringify(id)} is not valid; an id is 1–64 letters, digits, "_" or "-"`));
      } else if (this.pool.has(id)) {
        this.issue(fatal('duplicate-id', `two components have the id "${id}"; ids must be unique`));
      } else {
        this.pool.set(id, node);
        this.taken.add(id);
      }
    } else if (fromList) {
      this.issue(fatal('bad-node', `an entry of "components" (${describeNode(node)}) has no "id"; in the flat form every component needs one`));
    }
    if (!isInlineUiComponentName(node.component)) return;
    for (const { prop, kind, field } of childProps(node.component)) {
      const value = node[prop];
      if (kind === 'children') {
        if (Array.isArray(value)) for (const c of value) this.collect(c, depth + 1, false);
        else if (isJsonObject(value)) this.collect(value.template, depth + 1, false);
      } else if (Array.isArray(value) && field) {
        for (const item of value) if (isJsonObject(item)) this.collect(item[field], depth + 1, false);
      }
    }
  }

  private generate(candidate: string): string {
    let id = candidate;
    for (let n = 2; this.taken.has(id); n++) id = `${candidate}-${n}`;
    this.taken.add(id);
    return id;
  }

  /** Place one child reference; returns its id, or null when it cannot be placed. */
  visit(ref: unknown, candidate: string, depth: number, where: string): string | null {
    let node: Record<string, unknown>;
    if (typeof ref === 'string') {
      const found = this.pool.get(ref);
      if (!found) {
        this.issue(fatal('unknown-child', `${where} refers to "${ref}", but no component has that id`));
        return null;
      }
      node = found;
    } else if (isJsonObject(ref)) {
      node = ref;
    } else {
      this.issue(fatal('bad-node', `${where} must be a component node ({"component": …}) or a component id, not ${JSON.stringify(ref)?.slice(0, 40)}`));
      return null;
    }
    if (this.stack.has(node)) {
      this.issue(fatal('cycle', `${where} refers back to "${this.ids.get(node)}", which contains it; children cannot contain their parent`));
      return null;
    }
    if (this.placed.has(node)) {
      this.issue(fatal('shared-child', `component "${this.ids.get(node)}" is used in two places (again at ${where}); each component has one parent — give the copy its own id`));
      return null;
    }
    if (depth > INLINE_UI_VIEW_LIMITS.depth) {
      if (!this.tooDeep) this.issue(fatal('too-deep', `components are nested more than ${INLINE_UI_VIEW_LIMITS.depth} levels deep (at ${where}); flatten the layout`));
      this.tooDeep = true;
      return null;
    }
    if (this.components.length >= INLINE_UI_VIEW_LIMITS.components) {
      if (!this.tooMany) this.issue(fatal('too-many-components', `the view has more than ${INLINE_UI_VIEW_LIMITS.components} components; use a template or a Table for repeated items`));
      this.tooMany = true;
      return null;
    }
    const id = typeof node.id === 'string' && INLINE_UI_VIEW_ID_RE.test(node.id) ? node.id : this.generate(candidate);
    this.placed.add(node);
    this.ids.set(node, id);
    const name = node.component;
    if (!isInlineUiComponentName(name)) {
      this.issue(fatal('unknown-component', name === undefined
        ? `component "${id}" has no "component"; set it to one of ${INLINE_UI_COMPONENT_NAMES.join(', ')}`
        : `component "${id}" is ${JSON.stringify(name)}, which is not in the catalog; use one of ${INLINE_UI_COMPONENT_NAMES.join(', ')}`));
      return id;
    }
    const out: Record<string, unknown> = { id, component: name };
    this.components.push(out as unknown as InlineUiViewComponent);
    this.stack.add(node);
    for (const [prop, value] of Object.entries(node)) {
      if (prop === 'id' || prop === 'component') continue;
      const spec = inlineUiPropSpec(name, prop);
      if (!spec) {
        this.issue(repairable('unknown-prop', `${name} "${id}" has no prop "${prop}"; it is ignored (props: ${[...Object.keys(INLINE_UI_VIEW_CATALOG[name].props), 'visible'].join(', ')})`));
        continue;
      }
      if (spec.kind === 'children') out[prop] = this.children(value, id, prop, depth);
      else if (spec.kind === 'objects' && spec.fields && Object.values(spec.fields).some((f) => f.kind === 'child')) out[prop] = this.titled(value, id, name, prop, depth);
      else out[prop] = value;
    }
    this.stack.delete(node);
    return id;
  }

  private children(value: unknown, id: string, prop: string, depth: number): unknown {
    const where = `"${id}".${prop}`;
    if (Array.isArray(value)) {
      return value.map((c, i) => this.visit(c, childIdCandidate(id, i), depth + 1, `${where}[${i}]`)).filter((c): c is string => c !== null);
    }
    if (isJsonObject(value) && 'template' in value) {
      if (typeof value.path !== 'string') this.issue(fatal('bad-prop', `${where} is a template without a "path"; give the list to repeat over, e.g. {"path": "/items", "template": …}`));
      const extra = Object.keys(value).filter((k) => k !== 'path' && k !== 'template');
      if (extra.length) this.issue(repairable('unknown-prop', `${where} is a template; its keys ${extra.join(', ')} are ignored (keys: path, template)`));
      const template = this.visit(value.template, templateIdCandidate(id), depth + 1, `${where}.template`);
      return { path: value.path, template };
    }
    this.issue(fatal('bad-prop', `${where} must be a list of components or a template {"path": …, "template": …}`));
    return [];
  }

  /** `tabs` / `steps`: a list of `{ title, child }` whose child is placed. */
  private titled(value: unknown, id: string, name: string, prop: string, depth: number): unknown {
    if (!Array.isArray(value)) {
      this.issue(fatal('bad-prop', `${name} "${id}".${prop} must be a list of {"title": …, "child": <component>}`));
      return [];
    }
    return value.map((item, i) => {
      if (!isJsonObject(item)) {
        this.issue(fatal('bad-prop', `${name} "${id}".${prop}[${i}] must be an object {"title": …, "child": <component>}`));
        return item;
      }
      if (item.child === undefined) return item;
      return { ...item, child: this.visit(item.child, childIdCandidate(id, i), depth + 1, `"${id}".${prop}[${i}].child`) };
    });
  }

  /** Nodes of `components` that no parent reaches. */
  unused(): string[] {
    return [...this.pool.entries()].filter(([, node]) => !this.placed.has(node)).map(([id]) => id);
  }
}

function describeNode(node: Record<string, unknown>): string {
  return typeof node.component === 'string' ? `a ${node.component.slice(0, 40)}` : 'a node';
}

/** One child of a stored component: its id, the prop holding it, and whether it is a template. */
export interface ChildRef { id: string; prop: string; template: boolean }

/** The children of a stored component, in order (list children, a template, tab or step children). */
export function childRefs(component: InlineUiViewComponent): ChildRef[] {
  const c = component as unknown as Record<string, unknown>;
  const out: ChildRef[] = [];
  for (const { prop, kind, field } of childProps(component.component)) {
    const value = c[prop];
    if (kind === 'children') {
      if (Array.isArray(value)) for (const id of value) { if (typeof id === 'string') out.push({ id, prop, template: false }); }
      else if (isJsonObject(value) && typeof value.template === 'string') out.push({ id: value.template, prop, template: true });
    } else if (Array.isArray(value) && field) {
      for (const item of value) if (isJsonObject(item) && typeof item[field] === 'string') out.push({ id: item[field], prop, template: false });
    }
  }
  return out;
}

/** The normalizer's output, with the components built so far even when an issue is fatal (the lint checks them all in one round). */
export interface NormalizeParts extends NormalizeResult {
  components: InlineUiViewComponent[];
  data: JsonObject;
  computed: Record<string, string>;
}

/** Structure check and conversion to the stored adjacency list; see the module comment. */
export function normalizeView(doc: unknown): NormalizeResult {
  const { view, issues } = normalizeViewParts(doc);
  return view ? { view, issues } : { issues };
}

export function normalizeViewParts(doc: unknown): NormalizeParts {
  const n = new Normalizer();
  if (!isJsonObject(doc)) {
    return { issues: [fatal('not-object', 'a view is a JSON object {"data"?, "computed"?, "root": {"component": …}}')], components: [], data: {}, computed: {} };
  }
  const extra = Object.keys(doc).filter((k) => !TOP_LEVEL_KEYS.has(k));
  if (extra.length) n.issue(repairable('unknown-key', `the view's keys ${extra.map((k) => `"${k}"`).join(', ')} are ignored (keys: data, computed, root, components)`));

  let data: JsonObject = {};
  if (doc.data !== undefined) {
    if (isJsonObject(doc.data)) data = doc.data;
    else n.issue(fatal('bad-data', '"data" must be an object, e.g. {"qty": 1, "items": […]}'));
  }
  const computed: Record<string, string> = {};
  if (doc.computed !== undefined) {
    if (!isJsonObject(doc.computed)) {
      n.issue(fatal('bad-computed', '"computed" must be an object of name → expression strings, e.g. {"total": "price * qty"}'));
    } else {
      for (const [name, source] of Object.entries(doc.computed)) {
        if (typeof source === 'string') computed[name] = source;
        else n.issue(fatal('bad-computed', `computed "${name}" must be an expression string, not ${JSON.stringify(source).slice(0, 40)}`));
      }
    }
  }

  if (doc.components !== undefined && !Array.isArray(doc.components)) {
    n.issue(fatal('bad-node', '"components" must be a list of components, each with an "id"'));
  }
  const list: JsonValue[] = Array.isArray(doc.components) ? doc.components : [];
  list.forEach((c, i) => {
    if (isJsonObject(c)) n.collect(c, 1, true);
    else n.issue(fatal('bad-node', `components[${i}] must be a component object with an "id"`));
  });
  n.collect(doc.root, 1, false);

  const rootRef: unknown = doc.root ?? (list.some((c) => isJsonObject(c) && c.id === 'root') ? 'root' : undefined);
  let root: string | null = null;
  if (rootRef === undefined) {
    n.issue(fatal('no-root', 'the view has no root; add "root": {"component": "Column", "children": […]} (or, in the flat form, a component with id "root")'));
  } else {
    root = n.visit(rootRef, 'root', 1, 'root');
  }
  const unused = n.unused();
  if (unused.length) n.issue(repairable('unused-component', `components ${unused.map((u) => `"${u}"`).join(', ')} have no parent and are not shown; list them in a parent's children or remove them`));

  const parts = { issues: n.issues, components: n.components, data, computed };
  if (root === null || n.issues.some((i) => i.severity === 'fatal')) return parts;
  return { ...parts, view: { version: 1, root, components: n.components, data, computed } };
}

/**
 * The nested JSON an agent would write for a stored view (for
 * `inline-ui__source`). Ids that normalizing would generate again are
 * left out, so `normalizeView(viewToAuthored(v))` gives `v` back.
 */
export function viewToAuthored(view: InlineUiView): AuthoredView {
  const byId = new Map(view.components.map((c) => [c.id, c]));
  const build = (id: string, candidate: string): AuthoredNode => {
    const c = byId.get(id);
    if (!c) throw new Error(`view has no component "${id}"`);
    const { id: _id, component, ...props } = c;
    const out: Record<string, unknown> = id === candidate ? { component } : { id, component };
    for (const [prop, value] of Object.entries(props)) {
      const spec = inlineUiPropSpec(component, prop);
      if (spec?.kind === 'children') {
        out[prop] = Array.isArray(value)
          ? value.map((child: string, i: number) => build(child, childIdCandidate(id, i)))
          : { path: (value as { path: string }).path, template: build((value as { template: string }).template, templateIdCandidate(id)) };
      } else if (spec?.kind === 'objects' && spec.fields?.child?.kind === 'child' && Array.isArray(value)) {
        out[prop] = value.map((item: { child: string }, i: number) => ({ ...item, child: build(item.child, childIdCandidate(id, i)) }));
      } else {
        out[prop] = value;
      }
    }
    return out as unknown as AuthoredNode;
  };
  const authored: AuthoredView = {};
  if (Object.keys(view.data).length) authored.data = view.data;
  if (Object.keys(view.computed).length) authored.computed = view.computed;
  authored.root = build(view.root, 'root');
  return authored;
}
