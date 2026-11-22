/**
 * The data model of a view: JSON Pointer (RFC 6901) reads and immutable
 * writes, relative paths inside templates, and resolution of dynamic values
 * (docs/plans/inline-ui-views-spec.md §2.4).
 */
import { type ExprScope, evaluateExpression, interpolate } from './expr';
import { INLINE_UI_FORBIDDEN_KEYS, isJsonObject, readProperty } from './json';
import type { Dynamic, ExprRef, JsonObject, JsonValue, PathRef } from './types';

/** `{"@path": "…"}` with nothing else. */
export function isPathRef(value: unknown): value is PathRef {
  return isJsonObject(value) && typeof value['@path'] === 'string' && Object.keys(value).length === 1;
}

/** `{"@expr": "…"}` with nothing else. */
export function isExprRef(value: unknown): value is ExprRef {
  return isJsonObject(value) && typeof value['@expr'] === 'string' && Object.keys(value).length === 1;
}

const ESCAPE_RE = /~(?![01])/;

/**
 * Why `path` cannot be used, or null. An absolute path starts with `/`; a
 * relative one (no leading `/`) only inside a template, where it is read
 * from the item. `__proto__`, `constructor` and `prototype` are refused.
 */
export function pathProblem(path: string, opts: { inTemplate: boolean }): string | null {
  if (path === '' || path === '/') return 'the path is empty; point at a key such as "/name"';
  if (!path.startsWith('/') && !opts.inTemplate) return `"${path}" is relative, which only works inside a template; start it with "/"`;
  if (ESCAPE_RE.test(path)) return `"${path}" has a "~" that is not "~0" or "~1"`;
  const bad = splitSegments(path).find((s) => INLINE_UI_FORBIDDEN_KEYS.has(s));
  return bad === undefined ? null : `"${path}" uses the refused key "${bad}"`;
}

function splitSegments(path: string): string[] {
  const body = path.startsWith('/') ? path.slice(1) : path;
  return body.split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The segments of an absolute pointer (`''` is the whole document). Throws for a malformed or refused pointer. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`JSON Pointer "${pointer}" must start with "/"`);
  if (ESCAPE_RE.test(pointer)) throw new Error(`JSON Pointer "${pointer}" has a "~" that is not "~0" or "~1"`);
  const segments = splitSegments(pointer);
  const bad = segments.find((s) => INLINE_UI_FORBIDDEN_KEYS.has(s));
  if (bad !== undefined) throw new Error(`JSON Pointer "${pointer}" uses the refused key "${bad}"`);
  return segments;
}

/** One pointer segment, escaped. */
export function escapePointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** The value at `pointer`, or undefined when any step is missing. Own properties only. */
export function getPointer(data: JsonValue, pointer: string): JsonValue | undefined {
  let cur: JsonValue | undefined = data;
  for (const segment of parsePointer(pointer)) {
    cur = readProperty(cur, segment);
    if (cur === undefined) return undefined;
  }
  return cur;
}

const INDEX_RE = /^(?:0|[1-9]\d*)$/;
/** How far past a list's end a write may go (the gap is filled with null). */
const INLINE_UI_MAX_LIST_GAP = 200;

function setIn(container: JsonValue, segments: string[], at: number, value: JsonValue, pointer: string): JsonValue {
  if (at === segments.length) return value;
  const segment = segments[at];
  const nextIsIndex = at + 1 < segments.length && (segments[at + 1] === '-' || INDEX_RE.test(segments[at + 1]));
  const empty = (): JsonValue => (nextIsIndex ? [] : {});
  if (Array.isArray(container)) {
    const i = segment === '-' ? container.length : INDEX_RE.test(segment) ? Number(segment) : -1;
    if (i < 0) throw new Error(`cannot write "${pointer}": "${segment}" is not an index of a list`);
    if (i > container.length + INLINE_UI_MAX_LIST_GAP) throw new Error(`cannot write "${pointer}": index ${i} is far past the end of the list (${container.length} items)`);
    const copy = container.slice();
    while (copy.length < i) copy.push(null);
    copy[i] = setIn((i < container.length ? container[i] : null) ?? empty(), segments, at + 1, value, pointer);
    return copy;
  }
  if (!isJsonObject(container)) throw new Error(`cannot write "${pointer}": "/${segments.slice(0, at).map(escapePointerSegment).join('/')}" holds ${JSON.stringify(container).slice(0, 40)}, not an object or list`);
  const existing = Object.hasOwn(container, segment) ? container[segment] : undefined;
  return { ...container, [segment]: setIn(existing ?? empty(), segments, at + 1, value, pointer) };
}

/**
 * A copy of `data` with `value` at `pointer`; `data` is not changed.
 * Missing objects and lists on the way are created (a list when the next
 * segment is an index or `-`); `-` appends to a list. Throws for the root
 * pointer, a refused key, or a step through a string, number or boolean.
 */
export function setPointer(data: JsonObject, pointer: string, value: JsonValue): JsonObject {
  const segments = parsePointer(pointer);
  if (segments.length === 0) throw new Error('cannot replace the whole data model; write to a key such as "/name"');
  return setIn(data, segments, 0, value, pointer) as JsonObject;
}

/**
 * The absolute pointer for a path in `scope`: absolute paths as they are,
 * relative ones appended to the template item's pointer. Throws for a
 * relative path outside a template.
 */
export function resolvePath(path: string, scope: Pick<ExprScope, 'itemPath'>): string {
  if (path.startsWith('/')) return path;
  if (scope.itemPath === undefined) throw new Error(`"${path}" is relative, which only works inside a template`);
  return `${scope.itemPath}/${path}`;
}

/**
 * The value of a dynamic prop: a path is read (missing is null), an
 * expression evaluated, a string with `${…}` interpolated; any other literal
 * is returned as is (lists and objects are not walked). Throws for an
 * expression error or a relative path outside a template.
 */
export function resolveDynamic(value: Dynamic | undefined, scope: ExprScope): JsonValue {
  if (value === undefined) return null;
  if (isPathRef(value)) return getPointer(scope.data, resolvePath(value['@path'], scope)) ?? null;
  if (isExprRef(value)) return evaluateExpression(value['@expr'], scope);
  if (typeof value === 'string' && value.includes('${')) return interpolate(value, scope);
  return value as JsonValue;
}
