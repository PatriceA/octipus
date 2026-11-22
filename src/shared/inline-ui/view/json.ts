/** JSON helpers shared by the view modules. Property reads are own-property only and never touch the prototype chain. */
import type { JsonObject, JsonValue } from './types';

/** Keys that are never read or written, whatever the object (prototype safety). */
export const INLINE_UI_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INDEX_RE = /^(?:0|[1-9]\d*)$/;

/**
 * `value[key]` for a list index (number or digit string), `length` of a list
 * or string, or an own, non-forbidden key of an object; undefined otherwise.
 */
export function readProperty(value: JsonValue | undefined, key: string | number): JsonValue | undefined {
  if (Array.isArray(value)) {
    if (key === 'length') return value.length;
    const i = typeof key === 'number' ? key : INDEX_RE.test(key) ? Number(key) : Number.NaN;
    return Number.isInteger(i) && i >= 0 && i < value.length ? value[i] : undefined;
  }
  if (typeof value === 'string') return key === 'length' ? value.length : undefined;
  if (!isJsonObject(value)) return undefined;
  const k = String(key);
  return !INLINE_UI_FORBIDDEN_KEYS.has(k) && Object.hasOwn(value, k) ? value[k] : undefined;
}

/** Structural equality of two JSON values (NaN equals NaN). */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** Depth of a JSON value: a scalar is 0, a flat object or list 1. */
export function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((m, v) => Math.max(m, jsonDepth(v)), 0);
  if (isJsonObject(value)) return 1 + Object.values(value).reduce<number>((m, v) => Math.max(m, jsonDepth(v)), 0);
  return 0;
}

/** A value as JSON can carry it: numbers that are not finite (an expression's NaN or Infinity) become null. */
export function toJsonSafe(value: JsonValue): JsonValue {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  return value;
}

/** Whether a value parsed from JSON or sent by a client is plain JSON (no undefined, functions, class instances). */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
  if (typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((v) => isJsonValue(v, depth + 1));
}
