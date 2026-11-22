/**
 * Server-side checks of an authored view (docs/plans/inline-ui-views-spec.md
 * §3) and of an answer sent from one (§4). The renderer draws catalog
 * components only, so this is not a security boundary for markup; its job is
 * telling the model, in the same turn, what will not work and what is
 * accepted instead. Issues use part 1's type, so the repair round and the
 * notices apply unchanged.
 */
import { isSafeInlineUiLink } from '../bridge';
import { INLINE_UI_VIEW_LIMITS } from '../limits';
import type { InlineUiIssue } from '../lint';
import { INLINE_UI_VIEW_CATALOG, type PropSpec, inlineUiPropSpec } from './catalog';
import { getPointer, isExprRef, isPathRef, pathProblem } from './data';
import { type ExprNode, INLINE_UI_RESERVED_NAMES, InlineUiExprError, expressionNames, findComputedCycle, parseExpression, parseInterpolation } from './expr';
import { isValueFormat } from './format';
import { INLINE_UI_FORBIDDEN_KEYS, isJsonObject, isJsonValue, jsonDepth } from './json';
import { componentEventSteps } from './actions';
import { childRefs, normalizeViewParts, parseInlineUiViewBody } from './normalize';
import type { InlineUiView, InlineUiViewAction, InlineUiViewComponent, JsonObject, JsonValue } from './types';

export const INLINE_UI_EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const COMPUTED_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const L = INLINE_UI_VIEW_LIMITS;

export interface InlineUiViewLintResult {
  /** The stored form; present when no issue is fatal. */
  view?: InlineUiView;
  issues: InlineUiIssue[];
}

const fatal = (code: string, message: string): InlineUiIssue => ({ code, severity: 'fatal', message });
const repairable = (code: string, message: string): InlineUiIssue => ({ code, severity: 'repairable', message });

/** Where a component sits: inside a template (relative paths and `$item` work there) or not. */
interface Place { inTemplate: boolean }

function describeSpec(spec: PropSpec): string {
  const base = ((): string => {
    switch (spec.kind) {
      case 'string': return 'a string';
      case 'number': return 'a number';
      case 'boolean': return 'true or false';
      case 'enum': return `one of ${(spec.values ?? []).join(', ')}`;
      case 'format': return 'a format: text, number, currency:EUR, percent or date';
      case 'url': return 'an https: URL';
      case 'scalar': return 'a string, number or boolean';
      case 'any': return 'any value';
      case 'rows': return 'a list of objects';
      case 'objects': return `a list of {${Object.keys(spec.fields ?? {}).join(', ')}}`;
      case 'children': return 'a list of components or {"path", "template"}';
      case 'child': return 'a component or a component id';
      case 'action': return 'an action ({"set"}, {"openUrl"} or {"event"}) or a list of at most 4';
      case 'binding': return '{"@path": "/…"}, where the input writes';
    }
  })();
  return spec.dynamic && spec.kind !== 'binding' ? `${base} (or {"@path": …} / {"@expr": …})` : base;
}

const short = (v: unknown): string => (JSON.stringify(v) ?? String(v)).slice(0, 60);

class ViewLinter {
  readonly issues: InlineUiIssue[] = [];
  /** Names an expression outside a template may read: data keys, computed names, keys an action or input writes. */
  private readonly known = new Set<string>();

  constructor(private readonly data: JsonObject, private readonly computed: Record<string, string>) {
    for (const k of Object.keys(data)) this.known.add(k);
    for (const k of Object.keys(computed)) this.known.add(k);
  }

  add(i: InlineUiIssue): void { this.issues.push(i); }

  /** Record the top-level key a write path creates, so reading it is not reported as unknown. */
  noteWrite(path: string): void {
    if (path.startsWith('/')) this.known.add(path.slice(1).split('/')[0].replace(/~1/g, '/').replace(/~0/g, '~'));
  }

  checkExpression(source: string, where: string, place: Place): void {
    let ast: ExprNode;
    try {
      ast = parseExpression(source);
    } catch (err) {
      if (!(err instanceof InlineUiExprError)) throw err;
      this.add(fatal('bad-expr', `${where}: the expression ${short(source)} does not parse at position ${err.position}: ${err.message}`));
      return;
    }
    this.checkNames(expressionNames(ast), source, where, place);
  }

  private checkNames(names: string[], source: string, where: string, place: Place): void {
    for (const name of names) {
      if ((name === '$item' || name === '$index') && !place.inTemplate) {
        this.add(fatal('bad-expr', `${where}: ${name} in ${short(source)} only exists inside a template`));
      } else if (!place.inTemplate && !name.startsWith('$') && !this.known.has(name)) {
        this.add(repairable('unknown-name', `${where}: ${short(source)} reads "${name}", which is neither a data key nor a computed name; it will be null`));
      }
    }
  }

  checkText(text: string, where: string, place: Place): void {
    if (!text.includes('${')) return;
    try {
      for (const part of parseInterpolation(text)) {
        if (typeof part !== 'string') this.checkNames(expressionNames(part.ast), part.source, where, place);
      }
    } catch (err) {
      if (!(err instanceof InlineUiExprError)) throw err;
      this.add(fatal('bad-expr', `${where}: ${short(text)} has an expression that does not parse at position ${err.position}: ${err.message}`));
    }
  }

  checkPath(path: string, where: string, place: Place): boolean {
    const problem = pathProblem(path, { inTemplate: place.inTemplate });
    if (problem) this.add(fatal('bad-path', `${where}: ${problem}`));
    return !problem;
  }

  /** The initial list at an absolute path, for size checks; undefined when not a readable absolute path. */
  initialAt(path: string): JsonValue | undefined {
    if (!path.startsWith('/') || pathProblem(path, { inTemplate: false })) return undefined;
    return getPointer(this.data, path);
  }

  checkValue(spec: PropSpec, value: unknown, where: string, place: Place, listLimit?: number): void {
    if (isJsonObject(value) && Object.keys(value).some((k) => k.startsWith('@')) && !isPathRef(value) && !isExprRef(value)) {
      this.add(fatal('bad-prop', `${where}: ${short(value)} is not a dynamic value; write exactly {"@path": "/key"} or {"@expr": "expression"}`));
      return;
    }
    if (spec.kind === 'binding') {
      if (isPathRef(value)) {
        this.checkPath(value['@path'], where, place);
      } else {
        this.add(fatal('input-binding', `${where} must be {"@path": "/key"}: an input writes its value there (got ${short(value)})`));
      }
      return;
    }
    if (isPathRef(value) || isExprRef(value)) {
      if (!spec.dynamic) {
        this.add(fatal('bad-prop', `${where} is not dynamic; write ${describeSpec(spec)} as a literal`));
      } else if (isPathRef(value)) {
        if (this.checkPath(value['@path'], where, place) && listLimit !== undefined) this.checkListSize(this.initialAt(value['@path']), where, listLimit);
      } else {
        this.checkExpression(value['@expr'], where, place);
      }
      return;
    }
    const wrong = (): void => this.add(fatal('bad-prop', `${where} is ${short(value)}; it takes ${describeSpec(spec)}`));
    switch (spec.kind) {
      case 'string':
        if (typeof value !== 'string') return wrong();
        if (spec.dynamic) this.checkText(value, where, place);
        return;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) wrong();
        return;
      case 'boolean':
        if (typeof value !== 'boolean') wrong();
        return;
      case 'enum':
        if (typeof value !== 'string' || !spec.values?.includes(value)) wrong();
        return;
      case 'format':
        if (!isValueFormat(value)) wrong();
        return;
      case 'scalar':
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') wrong();
        return;
      case 'any':
        if (spec.dynamic && typeof value === 'string') this.checkText(value, where, place);
        return;
      case 'url':
        if (typeof value !== 'string') return wrong();
        if (spec.dynamic && value.includes('${')) this.checkText(value, where, place);
        else if (!isSafeInlineUiLink(value)) this.add(fatal('bad-url', `${where} is ${short(value)}; links must be https: URLs without credentials`));
        return;
      case 'rows':
        if (!Array.isArray(value) || !value.every(isJsonObject)) return wrong();
        if (listLimit !== undefined) this.checkListSize(value, where, listLimit);
        return;
      case 'objects':
        return this.checkObjects(spec, value, where, place);
      case 'action':
        return this.checkAction(value, where, place);
      case 'children':
      case 'child':
        // Placed by the normalizer, which reports bad shapes.
        return;
    }
  }

  private checkListSize(value: JsonValue | undefined, where: string, limit: number): void {
    if (Array.isArray(value) && value.length > limit) this.add(fatal('too-large', `${where} has ${value.length} items; the limit is ${limit}`));
  }

  private checkObjects(spec: PropSpec, value: unknown, where: string, place: Place): void {
    const fields = spec.fields ?? {};
    if (!Array.isArray(value)) {
      this.add(fatal('bad-prop', `${where} is ${short(value)}; it takes ${describeSpec(spec)}`));
      return;
    }
    if (spec.required && value.length === 0) this.add(fatal('bad-prop', `${where} is empty; it needs at least one item`));
    value.forEach((item, i) => {
      const at = `${where}[${i}]`;
      if (!isJsonObject(item)) {
        this.add(fatal('bad-prop', `${at} is ${short(item)}; it takes an object {${Object.keys(fields).join(', ')}}`));
        return;
      }
      for (const [key, field] of Object.entries(fields)) {
        if (item[key] === undefined || (item[key] === null && field.kind === 'child')) {
          if (field.required) this.add(fatal('missing-prop', `${at} needs "${key}" (${describeSpec(field)})`));
        } else {
          this.checkValue(field, item[key], `${at}.${key}`, place);
        }
      }
      const extra = Object.keys(item).filter((k) => !Object.hasOwn(fields, k));
      if (extra.length) this.add(repairable('unknown-prop', `${at} has no key ${extra.map((k) => `"${k}"`).join(', ')}; ignored (keys: ${Object.keys(fields).join(', ')})`));
    });
  }

  private checkAction(value: unknown, where: string, place: Place): void {
    const steps = Array.isArray(value) ? value : [value];
    if (steps.length === 0 || steps.length > L.actionsPerProp) {
      this.add(fatal('bad-action', `${where} lists ${steps.length} actions; give 1 to ${L.actionsPerProp}`));
      return;
    }
    steps.forEach((step, i) => {
      const at = steps.length > 1 ? `${where}[${i}]` : where;
      const keys = isJsonObject(step) ? Object.keys(step) : [];
      if (!isJsonObject(step) || keys.length !== 1 || !['set', 'openUrl', 'event'].includes(keys[0])) {
        this.add(fatal('bad-action', `${at} is ${short(step)}; an action is exactly one of {"set": {"path", "value"}}, {"openUrl": "https://…"} or {"event": {"name", "context"?, "userMessage"?}}`));
        return;
      }
      if (keys[0] === 'set') this.checkSet(step.set, `${at}.set`, place);
      else if (keys[0] === 'openUrl') this.checkValue({ kind: 'url', dynamic: true }, step.openUrl, `${at}.openUrl`, place);
      else this.checkEvent(step.event, `${at}.event`, place);
    });
  }

  private checkSet(set: JsonValue, where: string, place: Place): void {
    if (!isJsonObject(set) || typeof set.path !== 'string' || !Object.hasOwn(set, 'value')) {
      this.add(fatal('bad-action', `${where} is ${short(set)}; write {"path": "/key", "value": …}`));
      return;
    }
    this.checkPath(set.path, `${where}.path`, place);
    this.checkValue({ kind: 'any', dynamic: true }, set.value, `${where}.value`, place);
    const extra = Object.keys(set).filter((k) => k !== 'path' && k !== 'value');
    if (extra.length) this.add(repairable('unknown-prop', `${where} has no key ${extra.map((k) => `"${k}"`).join(', ')}; ignored (keys: path, value)`));
  }

  private checkEvent(event: JsonValue, where: string, place: Place): void {
    if (!isJsonObject(event)) {
      this.add(fatal('bad-action', `${where} is ${short(event)}; write {"name": "plan_chosen", "context": {…}, "userMessage": "…"}`));
      return;
    }
    if (typeof event.name !== 'string' || !INLINE_UI_EVENT_NAME_RE.test(event.name)) {
      this.add(fatal('bad-event-name', `${where}.name is ${short(event.name)}; an event name is lowercase letters, digits and "_", starting with a letter, at most 40 characters (e.g. "plan_chosen")`));
    }
    if (event.context !== undefined) {
      if (!isJsonObject(event.context)) {
        this.add(fatal('bad-action', `${where}.context must be an object of name → value`));
      } else {
        const keys = Object.keys(event.context);
        if (keys.length > L.contextKeys) this.add(fatal('too-large', `${where}.context has ${keys.length} keys; the limit is ${L.contextKeys}`));
        for (const key of keys) {
          if (INLINE_UI_FORBIDDEN_KEYS.has(key)) this.add(fatal('bad-action', `${where}.context uses the refused key "${key}"`));
          else this.checkValue({ kind: 'any', dynamic: true }, event.context[key], `${where}.context.${key}`, place);
        }
      }
    }
    if (event.userMessage !== undefined) this.checkValue({ kind: 'string', dynamic: true }, event.userMessage, `${where}.userMessage`, place);
    const extra = Object.keys(event).filter((k) => k !== 'name' && k !== 'context' && k !== 'userMessage');
    if (extra.length) this.add(repairable('unknown-prop', `${where} has no key ${extra.map((k) => `"${k}"`).join(', ')}; ignored (keys: name, context, userMessage)`));
  }

  checkComputed(): void {
    const names = Object.keys(this.computed);
    if (names.length > L.computedNames) this.add(fatal('too-large', `"computed" has ${names.length} names; the limit is ${L.computedNames}`));
    for (const name of names) {
      if (!COMPUTED_NAME_RE.test(name) || INLINE_UI_RESERVED_NAMES.has(name) || INLINE_UI_FORBIDDEN_KEYS.has(name)) {
        this.add(fatal('bad-computed', `computed name "${name}" is not allowed; use a plain name (letters, digits, "_"), not a keyword or function name`));
        continue;
      }
      this.checkExpression(this.computed[name], `computed "${name}"`, { inTemplate: false });
    }
    const cycle = findComputedCycle(this.computed);
    if (cycle) this.add(fatal('cycle', `computed names refer to each other in a cycle: ${cycle.join(' → ')}`));
  }
}

/** Per-component list limits: rows a Table, points a Chart may hold. */
const LIST_LIMITS: Partial<Record<string, Partial<Record<string, number>>>> = {
  Table: { rows: L.tableRows },
  Chart: { data: L.chartPoints },
};

function componentLabel(c: InlineUiViewComponent): string {
  return `${c.component} "${c.id}"`;
}

/** Components with their place (template or not) and the size of each template's subtree. */
function walkTree(components: InlineUiViewComponent[], rootId: string | undefined, lint: ViewLinter): Map<string, Place> {
  const byId = new Map(components.map((c) => [c.id, c]));
  const places = new Map<string, Place>();
  const subtreeSize = (id: string): number => {
    const c = byId.get(id);
    return c ? 1 + childRefs(c).reduce((n, ref) => n + subtreeSize(ref.id), 0) : 0;
  };
  const visit = (id: string, inTemplate: boolean): void => {
    const c = byId.get(id);
    if (!c || places.has(id)) return;
    places.set(id, { inTemplate });
    for (const ref of childRefs(c)) {
      if (ref.template) {
        if (inTemplate) lint.add(fatal('nested-template', `${componentLabel(c)}.${ref.prop} is a template inside another template; templates do not nest — use a Table, or flatten the data`));
        const size = subtreeSize(ref.id);
        const maxItems = Math.max(1, Math.min(L.templateItems, Math.floor(L.renderedComponents / size)));
        const path = (c as unknown as Record<string, { path?: unknown }>)[ref.prop]?.path;
        if (typeof path === 'string' && lint.checkPath(path, `${componentLabel(c)}.${ref.prop}.path`, { inTemplate })) {
          const list = lint.initialAt(path);
          if (list !== undefined && !Array.isArray(list)) lint.add(fatal('bad-prop', `${componentLabel(c)}.${ref.prop}.path "${path}" holds ${short(list)}; a template repeats over a list`));
          else if (Array.isArray(list) && list.length > maxItems) lint.add(fatal('too-large', `${componentLabel(c)}.${ref.prop} repeats over ${list.length} items; with ${size} components per copy the limit is ${maxItems}`));
        }
      }
      visit(ref.id, inTemplate || ref.template);
    }
  };
  if (rootId !== undefined) visit(rootId, false);
  for (const c of components) if (!places.has(c.id)) places.set(c.id, { inTemplate: false });
  return places;
}

/**
 * Note every key an input or a `set` action writes, before any expression is
 * checked, so reading a key that only a click creates is not reported.
 */
function noteWrites(components: InlineUiViewComponent[], lint: ViewLinter): void {
  const fromAction = (value: unknown): void => {
    for (const step of Array.isArray(value) ? value : [value]) {
      if (isJsonObject(step) && isJsonObject(step.set) && typeof step.set.path === 'string') lint.noteWrite(step.set.path);
    }
  };
  for (const c of components) {
    for (const [prop, value] of Object.entries(c as unknown as Record<string, unknown>)) {
      const spec = prop === 'id' || prop === 'component' ? undefined : inlineUiPropSpec(c.component, prop);
      if (spec?.kind === 'binding' && isPathRef(value)) lint.noteWrite(value['@path']);
      else if (spec?.kind === 'action') fromAction(value);
    }
  }
}

/** Cap the list so a repair message stays readable. */
function capIssues(issues: InlineUiIssue[]): InlineUiIssue[] {
  if (issues.length <= L.lintIssues) return issues;
  const rest = issues.slice(L.lintIssues);
  const severity = rest.some((i) => i.severity === 'fatal') ? 'fatal' : 'repairable';
  return [...issues.slice(0, L.lintIssues), { code: 'more-issues', severity, message: `…and ${rest.length} more issues of the same kinds` }];
}

/**
 * Check a view's fence body. `closed` is false when the reply ended before
 * the closing fence. Returns the stored form when nothing is fatal.
 */
export function lintInlineUiView(body: string, opts: { closed: boolean }): InlineUiViewLintResult {
  if (!opts.closed) return { issues: [fatal('cut-off', 'the view was cut off before its closing fence — make it smaller (use a template or a Table for repeated items)')] };
  if (body.length > L.bodyChars) return { issues: [fatal('too-large', `the view is ${body.length} characters; the limit is ${L.bodyChars}`)] };
  const parsed = parseInlineUiViewBody(body);
  if (!parsed.ok) {
    const at = parsed.line !== undefined ? ` at line ${parsed.line}, column ${parsed.column}` : '';
    return { issues: [fatal('invalid-json', `the view is not valid JSON${at}: ${parsed.message} (no comments or trailing commas; quote every key)`)] };
  }
  const parts = normalizeViewParts(parsed.doc);
  const lint = new ViewLinter(parts.data, parts.computed);
  for (const issue of parts.issues) lint.add(issue);
  const dataChars = JSON.stringify(parts.data).length;
  if (dataChars > L.dataChars) lint.add(fatal('too-large', `"data" is ${dataChars} characters as JSON; the limit is ${L.dataChars}`));

  noteWrites(parts.components, lint);
  const places = walkTree(parts.components, parts.view?.root ?? parts.components[0]?.id, lint);
  for (const c of parts.components) {
    const place = places.get(c.id) ?? { inTemplate: false };
    const props = c as unknown as Record<string, unknown>;
    for (const [prop, spec] of Object.entries(INLINE_UI_VIEW_CATALOG[c.component].props)) {
      if (spec.required && props[prop] === undefined) lint.add(fatal('missing-prop', `${componentLabel(c)} needs "${prop}" (${describeSpec(spec)})`));
    }
    for (const [prop, value] of Object.entries(props)) {
      const spec = prop === 'id' || prop === 'component' ? undefined : inlineUiPropSpec(c.component, prop);
      if (spec) lint.checkValue(spec, value, `${componentLabel(c)}.${prop}`, place, LIST_LIMITS[c.component]?.[prop]);
    }
  }
  lint.checkComputed();

  const issues = capIssues(lint.issues);
  if (!parts.view || issues.some((i) => i.severity === 'fatal')) return { issues };
  return { view: parts.view, issues };
}

/**
 * The server's checks of an `inlineUi.action` against the stored view (§4):
 * the component exists and carries an event of that name, the context has
 * exactly the declared keys, and it is JSON within the size and depth limits.
 * Returns what is wrong, or null. The caller checks that the block is a view
 * of the session.
 */
export function validateViewAction(view: InlineUiView, action: InlineUiViewAction): string | null {
  if (typeof action.name !== 'string' || !INLINE_UI_EVENT_NAME_RE.test(action.name)) return `the event name ${short(action.name)} is not valid`;
  if (typeof action.componentId !== 'string') return 'the action has no componentId';
  const component = view.components.find((c) => c.id === action.componentId);
  if (!component) return `the interactive answer has no component "${action.componentId.slice(0, 64)}"`;
  const event = componentEventSteps(component).find((e) => e.name === action.name);
  if (!event) return `component "${component.id}" has no event "${action.name}"`;
  if (!isJsonObject(action.context) || !isJsonValue(action.context)) return 'the event context must be a JSON object';
  const declared = Object.keys(event.context ?? {});
  const sent = Object.keys(action.context);
  const missing = declared.filter((k) => !Object.hasOwn(action.context, k));
  const extra = sent.filter((k) => !declared.includes(k));
  if (missing.length || extra.length) {
    const parts = [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `not declared: ${extra.slice(0, 10).join(', ')}` : ''].filter(Boolean);
    return `the context of event "${action.name}" must have exactly the keys ${declared.length ? declared.join(', ') : '(none)'} (${parts.join('; ')})`;
  }
  const chars = JSON.stringify(action.context).length;
  if (chars > L.contextChars) return `the event context is ${chars} characters as JSON; the limit is ${L.contextChars}`;
  const depth = jsonDepth(action.context);
  if (depth > L.contextDepth) return `the event context is nested ${depth} levels deep; the limit is ${L.contextDepth}`;
  return null;
}

/** The server's check of the data model a click sends with an answer (§4): a JSON object of at most 16 000 characters. Null when acceptable. */
export function validateViewData(data: unknown): string | null {
  if (!isJsonObject(data) || !isJsonValue(data)) return 'the answer data must be a JSON object';
  const chars = JSON.stringify(data).length;
  return chars > L.dataChars ? `the answer data is ${chars} characters as JSON; the limit is ${L.dataChars}` : null;
}
