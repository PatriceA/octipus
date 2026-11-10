/**
 * The cron expressions of plugin schedules (docs/PLUGIN-PACKAGES.md#schedules):
 * five fields — minute, hour, day of month, month, day of week — in UTC, each
 * `*`, a number, a range `a-b`, a step `*` + `/n` or `a-b/n`, or a comma list
 * of those. Day of week is 0-7 (0 and 7 are Sunday). As in cron, when both
 * day fields are restricted a day matches either.
 */

interface Field { min: number; max: number; name: string }
const FIELDS: Field[] = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day of month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 7, name: 'day of week' },
];

export interface CronSpec {
  sets: Array<Set<number>>;
  /** Whether day of month / day of week were `*`. */
  domAny: boolean;
  dowAny: boolean;
}

function parseField(text: string, field: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new Error(`${field.name}: "${part}" is not a number, range, step or *`);
    let lo = field.min;
    let hi = field.max;
    if (m[1] !== '*') {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? field.max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < field.min || hi > field.max || lo > hi) throw new Error(`${field.name}: "${part}" is outside ${field.min}-${field.max}`);
    if (step < 1) throw new Error(`${field.name}: a step is at least 1`);
    for (let v = lo; v <= hi; v += step) out.add(field.name === 'day of week' && v === 7 ? 0 : v);
  }
  return out;
}

/** Parse a five-field cron expression, or throw with the reason. */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('five fields: minute hour day-of-month month day-of-week');
  return {
    sets: parts.map((p, i) => parseField(p, FIELDS[i])),
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

/** The reason `expr` is not a valid schedule, or null. */
export function cronProblem(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Whether the minute starting at `at` (UTC) is one the spec fires on. */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  const [min, hour, dom, month, dow] = spec.sets;
  if (!min.has(at.getUTCMinutes()) || !hour.has(at.getUTCHours()) || !month.has(at.getUTCMonth() + 1)) return false;
  const domOk = dom.has(at.getUTCDate());
  const dowOk = dow.has(at.getUTCDay());
  if (spec.domAny || spec.dowAny) return domOk && dowOk;
  return domOk || dowOk;
}
