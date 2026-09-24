import { z } from 'zod';

const condition = z.object({
  path: z.string().max(200).default(''),
  operator: z.enum(['equals', 'in', 'contains', 'changed']),
  value: z.unknown().optional(),
}).strict();
const tool = z.object({ kind: z.literal('tool'), name: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}), condition }).strict();
const browser = z.object({ kind: z.literal('browser'), tabId: z.number().int().nonnegative(), url: z.string().url().refine(url => /^https?:/.test(url), 'Browser monitors require an HTTP(S) URL'), selector: z.string().min(1).max(500), condition }).strict();
export const monitorSourceSchema = z.discriminatedUnion('kind', [
  tool, browser,
  z.object({ kind: z.literal('time'), at: z.string().datetime() }).strict(),
  z.object({ kind: z.literal('event'), type: z.string().min(1).max(100), condition, fallback: tool.optional() }).strict(),
]);
export const createMonitorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  continuation: z.string().trim().min(1).max(8000),
  source: monitorSourceSchema,
  intervalSeconds: z.number().int().min(10).max(3600).default(30),
  timeoutSeconds: z.number().int().min(30).max(604800).default(1800),
}).strict().superRefine((input, ctx) => {
  const sources = [input.source, ...(input.source.kind === 'event' && input.source.fallback ? [input.source.fallback] : [])];
  for (const source of sources) {
    if (source.kind === 'time') continue;
    const c = source.condition;
    if (c.operator !== 'changed' && c.value === undefined) ctx.addIssue({ code: 'custom', message: 'condition.value is required', path: ['source'] });
    if (c.operator === 'in' && !Array.isArray(c.value)) ctx.addIssue({ code: 'custom', message: 'in requires an array', path: ['source'] });
  }
});
export type MonitorSource = z.infer<typeof monitorSourceSchema>;
export type MonitorCondition = z.infer<typeof condition>;
export type CreateMonitor = z.infer<typeof createMonitorSchema>;
export type MonitorStatus = 'armed' | 'paused' | 'ready' | 'delivering' | 'completed' | 'cancelled' | 'blocked';
export type Observation = { value: unknown; observedAt: string; reason: 'matched' | 'timeout' };

export function field(value: unknown, path: string): unknown {
  for (const key of path ? path.split('.') : []) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function matches(condition: MonitorCondition, value: unknown, previous?: unknown): boolean {
  if (value === undefined) return false; // Missing elements/fields are not successful observations.
  switch (condition.operator) {
    case 'equals': return canonical(value) === canonical(condition.value);
    case 'in': return Array.isArray(condition.value) && condition.value.some(v => canonical(v) === canonical(value));
    case 'contains': return typeof value === 'string' && typeof condition.value === 'string' && value.includes(condition.value);
    case 'changed': return previous !== undefined && canonical(value) !== canonical(previous);
  }
}
