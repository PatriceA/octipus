/**
 * Turning view values into text. Locale and time zone are parameters with
 * fixed defaults (`en-US`, `UTC`), so the server's text rendering and the
 * tests do not depend on the machine they run on; the web passes the
 * viewer's.
 */
import type { JsonValue, ValueFormat } from './types';

export const INLINE_UI_DEFAULT_LOCALE = 'en-US';
export const INLINE_UI_DEFAULT_TIME_ZONE = 'UTC';
/** What a number that is not finite (or a date that does not parse) renders as. */
export const INLINE_UI_NO_VALUE = '—';

export interface FormatOptions {
  /** BCP 47 locale; default `en-US`. */
  locale?: string;
  /** IANA time zone for dates with a time; default `UTC`. Date-only values are always read as calendar dates. */
  timeZone?: string;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const MAX_CACHED_FORMATS = 200;

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = numberFormats.get(key);
  if (!f) {
    if (numberFormats.size >= MAX_CACHED_FORMATS) numberFormats.clear();
    f = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, f);
  }
  return f;
}

/** A number as an operand: numbers as is, booleans 1/0, numeric strings parsed, everything else NaN. */
export function toNumber(value: JsonValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

/** JavaScript truthiness: null, false, 0, NaN and '' are false; lists and objects (even empty) are true. */
export function isTruthy(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined || value === false || value === '') return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  return true;
}

function digitsOption(digits: number | undefined): Intl.NumberFormatOptions {
  if (digits === undefined || !Number.isFinite(digits)) return {};
  const d = Math.max(0, Math.min(10, Math.trunc(digits)));
  return { minimumFractionDigits: d, maximumFractionDigits: d };
}

export function formatNumber(value: JsonValue | undefined, digits?: number, opts: FormatOptions = {}): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return INLINE_UI_NO_VALUE;
  return numberFormat(opts.locale ?? INLINE_UI_DEFAULT_LOCALE, digitsOption(digits)).format(n);
}

/** `code` is an ISO 4217 code (`EUR`); throws for anything else. */
export function formatCurrency(value: JsonValue | undefined, code: string, opts: FormatOptions = {}): string {
  if (!/^[A-Za-z]{3}$/.test(code)) throw new RangeError(`"${code.slice(0, 20)}" is not a currency code; use an ISO 4217 code such as EUR or USD`);
  const n = toNumber(value);
  if (!Number.isFinite(n)) return INLINE_UI_NO_VALUE;
  return numberFormat(opts.locale ?? INLINE_UI_DEFAULT_LOCALE, { style: 'currency', currency: code.toUpperCase() }).format(n);
}

/** `value` is a ratio: 0.25 is 25 %. Digits default to 0. */
export function formatPercent(value: JsonValue | undefined, digits = 0, opts: FormatOptions = {}): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return INLINE_UI_NO_VALUE;
  return numberFormat(opts.locale ?? INLINE_UI_DEFAULT_LOCALE, { style: 'percent', ...digitsOption(digits) }).format(n);
}

export const INLINE_UI_DATE_STYLES = ['short', 'medium', 'long', 'full', 'time', 'datetime'] as const;
export type DateStyle = (typeof INLINE_UI_DATE_STYLES)[number];

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date as text. `value` is an ISO 8601 string or milliseconds since the
 * epoch. `style` is a date style, `time`, or `datetime` (medium date, short
 * time); default `medium`. A date-only string is a calendar date: it is
 * formatted in UTC so no time zone shifts it to the day before.
 */
export function formatDate(value: JsonValue | undefined, style: string = 'medium', opts: FormatOptions = {}): string {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return INLINE_UI_NO_VALUE;
  if (!(INLINE_UI_DATE_STYLES as readonly string[]).includes(style)) {
    throw new RangeError(`"${style.slice(0, 20)}" is not a date style; use one of ${INLINE_UI_DATE_STYLES.join(', ')}`);
  }
  const dateOnly = typeof value === 'string' && DATE_ONLY_RE.test(value);
  const timeZone = dateOnly ? 'UTC' : opts.timeZone ?? INLINE_UI_DEFAULT_TIME_ZONE;
  const options: Intl.DateTimeFormatOptions =
    style === 'time' ? { timeStyle: 'short' }
    : style === 'datetime' ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: style as Intl.DateTimeFormatOptions['dateStyle'] };
  return new Intl.DateTimeFormat(opts.locale ?? INLINE_UI_DEFAULT_LOCALE, { ...options, timeZone }).format(ms);
}

/**
 * Any value as display text: null is empty, numbers use the locale without
 * grouping (so a year stays `2026`), a number that is not finite is `—`,
 * lists are joined with `, `, objects are JSON.
 */
export function valueToText(value: JsonValue | undefined, opts: FormatOptions = {}): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return INLINE_UI_NO_VALUE;
    return numberFormat(opts.locale ?? INLINE_UI_DEFAULT_LOCALE, { maximumFractionDigits: 10, useGrouping: false }).format(value);
  }
  if (Array.isArray(value)) return value.map((v) => valueToText(v, opts)).join(', ');
  return JSON.stringify(value);
}

/** Whether a string is a value format (`text`, `number`, `currency:EUR`, `percent`, `date`). */
export function isValueFormat(format: unknown): format is ValueFormat {
  return typeof format === 'string' && (format === 'text' || format === 'number' || format === 'percent' || format === 'date' || /^currency:[A-Za-z]{3}$/.test(format));
}

/** A value in a table column or slider format; no format is `valueToText`. */
export function formatValue(value: JsonValue | undefined, format: ValueFormat | undefined, opts: FormatOptions = {}): string {
  if (format === 'number') return formatNumber(value, undefined, opts);
  if (format === 'percent') return formatPercent(value, 0, opts);
  if (format === 'date') return formatDate(value, 'medium', opts);
  if (format?.startsWith('currency:')) return formatCurrency(value, format.slice('currency:'.length), opts);
  return valueToText(value, opts);
}
