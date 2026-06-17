/**
 * Shared date/time formatting for grounding LLM prompts in "today".
 *
 * Every model-facing date string (orchestrator system prompt, swarm child
 * message, research planner) should come from here so the format stays
 * consistent and single-clock — all fields derived from one `Date` in the
 * local timezone, never mixing a local date with a UTC ISO date (which can
 * disagree by a day near midnight on non-UTC servers).
 */

const LONG_DATE_OPTS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

/** Long human-readable date, e.g. "Monday, June 15, 2026" (en-US, local clock). */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString('en-US', LONG_DATE_OPTS);
}

/**
 * Long date + 24h time + IANA timezone label, e.g.
 * "Monday, June 15, 2026 14:30 (Europe/Paris)".
 *
 * All three fields come from the same local `Date`, so they never disagree.
 * Callers add their own label/prefix (e.g. "CURRENT DATE/TIME: ").
 */
export function formatDateTimeContext(date: Date): string {
  const time = date.toLocaleTimeString('en-US', TIME_OPTS);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formatLongDate(date)} ${time} (${tz})`;
}
