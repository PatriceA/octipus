/**
 * Natural-language capture for to-dos: "call dentist tomorrow 3pm !high #personal"
 * → title "call dentist", due tomorrow at 15:00, priority 3, list "personal".
 *
 * One pure function shared by every capture surface: the web's capture line
 * and global quick-add (which show the parsed chips before submit), the
 * `/todo` chat command, and `POST /api/tasks` with `quick` (so the mobile app
 * gets identical behaviour without a copy). English only. What it reads:
 *
 *   Dates   today, tonight, tomorrow (tmrw), day after tomorrow, monday … sunday
 *           ("on fri", "next tue" = that day of next week), next week (Monday),
 *           this weekend / weekend (Saturday), next month (the 1st),
 *           in 3 days / in 2 weeks / in a month, 2026-12-01, dec 1, 1 december
 *           (an optional "on", "by" or "due" before any of them is absorbed)
 *   Times   3pm, 3:30pm, 15:00, at 9, noon, morning (09:00), afternoon (14:00),
 *           evening (18:00); a time alone means today, or tomorrow once it passed
 *   Repeat  daily, every day, weekdays, every weekday, weekly, every week,
 *           monthly, yearly, every 2 weeks, every monday (and the first such day is due)
 *   Priority !high / !!! / !3, !medium / !! / !2, !low / ! / !1
 *   Star    * on its own, or !important / !star
 *   List    #personal, #house-work (a letter first, so #3 is not a list; matched to an existing list by name,
 *           ignoring case and "-"/"_" for spaces; else kept as typed)
 *
 * Everything recognised is removed from the title and reported as a token
 * with its span, so a UI can show it as a chip. A text that would be left
 * with no title is taken literally ("Tomorrow" is a to-do called Tomorrow).
 */
import { REPEAT_PRESETS, type TaskRepeat } from './repeat';
import { isValidTimezone, localDateTimeIn, localWallClock } from './rank';

export type QuickAddTokenKind = 'due' | 'time' | 'repeat' | 'priority' | 'important' | 'list';

export interface QuickAddToken {
  kind: QuickAddTokenKind;
  /** The text as typed. */
  text: string;
  start: number;
  end: number;
  /** A short human label for a chip ("Tomorrow", "15:00", "High", "#personal"). */
  label: string;
}

export interface ParsedQuickAdd {
  title: string;
  /** Calendar date in the user's zone and an optional 24h time. */
  due: { date: string; time: string | null } | null;
  /** 1 low … 3 high; null when not given. */
  priority: number | null;
  important: boolean;
  category: string | null;
  repeat: TaskRepeat | null;
  tokens: QuickAddToken[];
}

export interface QuickAddOptions {
  now?: Date;
  /** IANA zone "today" is read in. Default UTC. */
  timezone?: string;
  /** Existing lists (`category` values), for matching `#house-work` to "House work". */
  lists?: readonly string[];
}

interface DateParts { year: number; month: number; day: number }

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const FULL_WEEKDAY = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const ANY_WEEKDAY = 'sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat';
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH = 'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec';
const WEEKDAY_TITLE = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Words that may lead a date and belong to it. */
const LEAD = String.raw`(?:(?:on|by|due)\s+)?`;
/** A word boundary that also works after "!" and before "#" (`\b` does not). */
const START = String.raw`(?<![\p{L}\p{N}_])`;
const END = String.raw`(?![\p{L}\p{N}_])`;

function addDays(d: DateParts, n: number): DateParts {
  const x = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
}
function weekday(d: DateParts): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}
function iso(d: DateParts): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
function validDate(d: DateParts): boolean {
  const x = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return x.getUTCFullYear() === d.year && x.getUTCMonth() === d.month - 1 && x.getUTCDate() === d.day;
}
/** The next `target` weekday strictly after `today`. */
function nextWeekday(today: DateParts, target: number): DateParts {
  const diff = ((target - weekday(today) + 7) % 7) || 7;
  return addDays(today, diff);
}
/** `target` weekday in next week (weeks start on Monday). */
function weekdayNextWeek(today: DateParts, target: number): DateParts {
  const sinceMonday = (weekday(today) + 6) % 7;
  const nextMonday = addDays(today, 7 - sinceMonday);
  return addDays(nextMonday, (target + 6) % 7);
}
function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A chip label for a due date relative to today. */
export function dueChipLabel(date: string, today: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return WEEKDAY_TITLE[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${WEEKDAY_TITLE[new Date(Date.UTC(y, m - 1, d)).getUTCDay()].slice(0, 3)}, ${MONTH_SHORT[m - 1]} ${d}${y !== ty ? ` ${y}` : ''}`;
}

/** Normalise a list name for matching: case, and "-"/"_" as spaces. */
function listKey(name: string): string {
  return name.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseQuickAdd(text: string, opts: QuickAddOptions = {}): ParsedQuickAdd {
  const zone = isValidTimezone(opts.timezone) ? opts.timezone : 'UTC';
  const now = opts.now ?? new Date();
  const wall = localWallClock(now.getTime(), zone);
  const today: DateParts = { year: wall.year, month: wall.month, day: wall.day };
  const todayIso = iso(today);
  const taken: QuickAddToken[] = [];
  const free = (start: number, end: number) => taken.every((t) => end <= t.start || start >= t.end);
  /** Every match of `re` over free text; `on` decides and labels it (null = not this one). */
  const scan = (source: string, kind: QuickAddTokenKind, on: (m: RegExpExecArray) => string | null) => {
    const re = new RegExp(source, 'giu');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      if (!free(start, end)) continue;
      const label = on(m);
      if (label !== null) taken.push({ kind, text: m[0], start, end, label });
    }
  };

  // Asserted, not annotated: the closures below assign these, which control
  // flow analysis cannot see, so a plain `= null` would read as null forever.
  let date = null as DateParts | null;
  let time = null as string | null;
  let priority = null as number | null;
  let important = false as boolean;
  let category = null as string | null;
  let repeat = null as TaskRepeat | null;
  let tonight = false as boolean;
  const setDate = (d: DateParts): string | null => {
    if (date || !validDate(d)) return null;
    date = d;
    return dueChipLabel(iso(d), todayIso);
  };

  // List: #name. Matched to an existing list when one fits.
  scan(String.raw`${START}#(\p{L}[\p{L}\p{N}_\-/]*)`, 'list', (m) => {
    if (category) return null;
    const typed = m[1];
    const known = opts.lists?.find((l) => listKey(l) === listKey(typed));
    category = known ?? typed;
    return `#${category}`;
  });

  // Star.
  scan(String.raw`(?<=^|\s)(?:\*|!important|!star)(?=\s|$)`, 'important', () => {
    if (important) return null;
    important = true;
    return 'Important';
  });

  // Priority.
  scan(String.raw`(?<=^|\s)(?:!(high|hi|h|medium|med|m|low|lo|l|[123])|(!{1,3}))(?=\s|$)`, 'priority', (m) => {
    if (priority !== null) return null;
    const word = (m[1] ?? '').toLowerCase();
    const bangs = m[2]?.length ?? 0;
    priority = bangs || (/^(high|hi|h|3)$/.test(word) ? 3 : /^(medium|med|m|2)$/.test(word) ? 2 : 1);
    return ['', 'Low', 'Medium', 'High'][priority];
  });

  // Repeat (before dates: "every monday" is a rule, not a date).
  const preset = (name: keyof typeof REPEAT_PRESETS): TaskRepeat => {
    const p: TaskRepeat = REPEAT_PRESETS[name];
    return { unit: p.unit, interval: p.interval, ...(p.weekdays ? { weekdays: [...p.weekdays] } : {}) };
  };
  scan(String.raw`${START}every\s+(\d{1,3}|other)\s+(day|week|month|year)s?${END}`, 'repeat', (m) => {
    if (repeat) return null;
    const n = m[1].toLowerCase() === 'other' ? 2 : Number(m[1]);
    if (n < 1 || n > 365) return null;
    repeat = { unit: m[2].toLowerCase() as TaskRepeat['unit'], interval: n };
    return `Every ${n} ${m[2].toLowerCase()}s`;
  });
  scan(String.raw`${START}every\s+((?:${ANY_WEEKDAY})(?:\s*(?:,|and|&)\s*(?:${ANY_WEEKDAY}))*)${END}`, 'repeat', (m) => {
    if (repeat) return null;
    const days = [...new Set(m[1].toLowerCase().split(/\s*(?:,|and|&)\s*/).map((w) => WEEKDAYS[w.trim()]))].sort((a, b) => a - b);
    repeat = { unit: 'week', interval: 1, weekdays: days };
    // The first occurrence is the next of those days, unless a date is given too.
    const first = days.map((d) => nextWeekday(addDays(today, -1), d)).sort((a, b) => iso(a).localeCompare(iso(b)))[0];
    if (!date) date = first;
    return `Every ${days.map((d) => WEEKDAY_TITLE[d].slice(0, 3)).join(', ')}`;
  });
  scan(String.raw`${START}(?:every\s+(day|weekday|workday|week|month|year)|(daily|weekdays|weekly|monthly|yearly|annually))${END}`, 'repeat', (m) => {
    if (repeat) return null;
    const word = (m[1] ?? m[2]).toLowerCase();
    const name = ({ day: 'daily', daily: 'daily', weekday: 'weekdays', workday: 'weekdays', weekdays: 'weekdays', week: 'weekly', weekly: 'weekly', month: 'monthly', monthly: 'monthly', year: 'yearly', yearly: 'yearly', annually: 'yearly' } as const)[word as 'day'];
    repeat = preset(name);
    return { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[name];
  });

  // Dates.
  scan(String.raw`${START}${LEAD}(\d{4})-(\d{2})-(\d{2})${END}`, 'due', (m) =>
    setDate({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }));
  const monthDay = (month: number, day: number, year?: string): string | null => {
    let d: DateParts = { year: year ? Number(year) : today.year, month, day };
    if (!year && iso(d) < todayIso) d = { ...d, year: d.year + 1 };
    return setDate(d);
  };
  scan(String.raw`${START}${LEAD}(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?${END}`, 'due', (m) =>
    monthDay(MONTHS[m[1].toLowerCase()], Number(m[2]), m[3]));
  scan(String.raw`${START}${LEAD}(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH})\.?(?:\s+(\d{4}))?${END}`, 'due', (m) =>
    monthDay(MONTHS[m[2].toLowerCase()], Number(m[1]), m[3]));
  scan(String.raw`${START}${LEAD}(?:the\s+)?day\s+after\s+tomorrow${END}`, 'due', () => setDate(addDays(today, 2)));
  scan(String.raw`${START}${LEAD}(today|tonight|tomorrow|tmrw|tmr)${END}`, 'due', (m) => {
    const word = m[1].toLowerCase();
    const label = setDate(word === 'today' || word === 'tonight' ? today : addDays(today, 1));
    if (label && word === 'tonight') tonight = true;
    return label;
  });
  scan(String.raw`${START}${LEAD}next\s+(${ANY_WEEKDAY})${END}`, 'due', (m) => setDate(weekdayNextWeek(today, WEEKDAYS[m[1].toLowerCase()])));
  scan(String.raw`${START}(?:on|by|due)\s+(${ANY_WEEKDAY})${END}`, 'due', (m) => setDate(nextWeekday(today, WEEKDAYS[m[1].toLowerCase()])));
  scan(String.raw`${START}(${FULL_WEEKDAY})${END}`, 'due', (m) => setDate(nextWeekday(today, WEEKDAYS[m[1].toLowerCase()])));
  scan(String.raw`${START}${LEAD}next\s+week${END}`, 'due', () => setDate(weekdayNextWeek(today, 1)));
  scan(String.raw`${START}${LEAD}(?:this\s+)?weekend${END}`, 'due', () => setDate(weekday(today) === 6 ? today : nextWeekday(today, 6)));
  scan(String.raw`${START}${LEAD}next\s+month${END}`, 'due', () =>
    setDate(today.month === 12 ? { year: today.year + 1, month: 1, day: 1 } : { year: today.year, month: today.month + 1, day: 1 }));
  scan(String.raw`${START}in\s+(\d{1,3}|a|an|one)\s+(day|week|month)s?${END}`, 'due', (m) => {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
    const unit = m[2].toLowerCase();
    if (unit === 'day') return setDate(addDays(today, n));
    if (unit === 'week') return setDate(addDays(today, 7 * n));
    const months = today.month - 1 + n;
    const year = today.year + Math.floor(months / 12);
    const month = (months % 12) + 1;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return setDate({ year, month, day: Math.min(today.day, last) });
  });

  // Times.
  const setTime = (h: number, min: number): string | null => {
    if (time || h > 23 || min > 59) return null;
    time = hhmm(h, min);
    return time;
  };
  scan(String.raw`${START}(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)${END}`, 'time', (m) => {
    let h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    const pm = m[3].toLowerCase().startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return setTime(h, Number(m[2] ?? 0));
  });
  scan(String.raw`${START}(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)${END}`, 'time', (m) => setTime(Number(m[1]), Number(m[2])));
  scan(String.raw`${START}at\s+(\d{1,2})${END}`, 'time', (m) => setTime(Number(m[1]), 0));
  scan(String.raw`${START}(?:at\s+|in\s+the\s+)?(noon|midday|morning|afternoon|evening)${END}`, 'time', (m) => {
    const word = m[1].toLowerCase();
    const [h] = ({ noon: [12], midday: [12], morning: [9], afternoon: [14], evening: [18] } as Record<string, [number]>)[word];
    return setTime(h, 0);
  });

  const stripped = (() => {
    let out = '';
    let at = 0;
    for (const t of [...taken].sort((a, b) => a.start - b.start)) {
      out += `${text.slice(at, t.start)} `;
      at = t.end;
    }
    return (out + text.slice(at)).replace(/\s+/g, ' ').trim();
  })();
  if (!stripped) {
    return { title: text.trim(), due: null, priority: null, important: false, category: null, repeat: null, tokens: [] };
  }

  if (tonight && !time) time = '20:00';
  // A time alone is today, or tomorrow once that time has passed.
  let dueDate: DateParts | null = date;
  if (!dueDate && time) {
    const [h, min] = time.split(':').map(Number);
    dueDate = h * 60 + min > wall.hour * 60 + wall.minute ? today : addDays(today, 1);
  }
  return {
    title: stripped,
    due: dueDate ? { date: iso(dueDate), time } : null,
    priority,
    important,
    category,
    repeat,
    tokens: taken.sort((a, b) => a.start - b.start),
  };
}

/**
 * A parsed due as the `dueAt` the tasks API takes: a bare `YYYY-MM-DD` for a
 * day (the server ends it in the user's zone), or the ISO instant of the
 * date and time in `timezone`.
 */
export function quickAddDueAt(due: ParsedQuickAdd['due'], timezone: string): string | null {
  if (!due) return null;
  if (!due.time) return due.date;
  const [y, m, d] = due.date.split('-').map(Number);
  const [h, min] = due.time.split(':').map(Number);
  return localDateTimeIn(y, m, d, h, min, isValidTimezone(timezone) ? timezone : 'UTC').toISOString();
}
