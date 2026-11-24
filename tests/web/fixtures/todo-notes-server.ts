import type { Page } from '@playwright/test';
import { json } from './api-stubs';

/**
 * One stateful stand-in for /api/tasks, /api/notes and /api/calendar, for
 * the specs of to-dos linked to notes and the Today page. It answers as
 * src/api/routes/{tasks,notes}.ts do for what those pages use, including
 * the links: `linkedNotes` on to-dos, `linkedTasks` on a note, a note save
 * refused as stale over another body (`ifSha256`), a to-do's status reaching
 * its marked line, and a save that ticks a marked line completing its to-do.
 */

const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dayFromToday = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };
export const endOfDay = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(23, 59, 59, 999); return d.toISOString(); };
export const TODAY = localDay(new Date());
export const dailyTemplate = (date: string) => `# ${date}\n\n## Notes\n\n## Tasks\n`;

/** A stand-in for the server's body sha256: deterministic, 64 hex characters. */
export function sha(text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

// biome-ignore lint/suspicious/noExplicitAny: stub rows are loose JSON
type Row = Record<string, any>;
let seq = 0;
export const T = (id: string, title: string, o: Row = {}): Row => ({
  id, title, status: 'open', priority: 0, source: 'user', blockedBy: [], parentId: null, category: null, notes: null, dueAt: null, remindAt: null,
  important: false, myDayOn: null, repeat: null, repeatNextId: null, sortOrder: (seq += 10), createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', completedAt: null, ...o,
});
export const N = (id: string, title: string, body: string, o: Row = {}): Row => ({
  id, title, slug: o.slug ?? title.toLowerCase().replace(/\s+/g, '-'), body, noteKind: 'note', noteDate: null, tags: [], pinned: false, frontmatter: {},
  archivedAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: new Date().toISOString(), ...o,
});

export interface Link { taskId: string; noteId: string; anchor: string | null }

export interface Server {
  tasks: Row[];
  notes: Row[];
  links: Link[];
  events: Row[];
  calls: { method: string; path: string; body: Row | undefined }[];
  posts(prefix: string): Row[];
}

const MARKER = /[ \t]+\^todo-([a-z0-9]{6,16})[ \t]*$/;
const TASK = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/;

function anchors(body: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of body.split('\n')) {
    const m = TASK.exec(line);
    const tail = MARKER.exec(line);
    if (m && tail && !out.has(tail[1])) out.set(tail[1], m[2] !== ' ');
  }
  return out;
}

function setChecked(body: string, anchor: string, checked: boolean): string {
  return body.split('\n').map((line) => {
    const m = TASK.exec(line);
    if (!m || MARKER.exec(line)?.[1] !== anchor) return line;
    return `${m[1]}${checked ? 'x' : ' '}]${line.slice(m[0].length)}`;
  }).join('\n');
}

export async function serve(page: Page, init: { tasks?: Row[]; notes?: Row[]; links?: Link[]; events?: Row[] | null } = {}): Promise<Server> {
  seq = 0;
  const s: Server = {
    tasks: init.tasks ?? [], notes: init.notes ?? [], links: init.links ?? [], events: init.events ?? [], calls: [],
    posts: (prefix) => s.calls.filter((c) => c.method === 'POST' && c.path.startsWith(prefix)).map((c) => c.body ?? {}),
  };
  const connected = init.events !== null;
  const noteFull = (n: Row) => ({ ...n, bodySha256: sha(n.body) });
  const linkedNotes = (taskId: string) => s.links.filter((l) => l.taskId === taskId).flatMap((l) => {
    const n = s.notes.find((x) => x.id === l.noteId);
    return n ? [{ id: n.id, title: n.title, slug: n.slug, noteKind: n.noteKind, noteDate: n.noteDate, archived: !!n.archivedAt, anchor: l.anchor }] : [];
  });
  const taskView = (t: Row) => ({ ...t, linkedNotes: linkedNotes(t.id) });
  const linkedTasks = (noteId: string) => s.links.filter((l) => l.noteId === noteId).flatMap((l) => {
    const t = s.tasks.find((x) => x.id === l.taskId);
    return t ? [{ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt, completedAt: t.completedAt, repeating: !!t.repeat, anchor: l.anchor }] : [];
  });
  const setStatus = (t: Row, status: string) => {
    t.status = status;
    t.completedAt = status === 'done' ? new Date().toISOString() : null;
  };

  await page.route('**/api/roles', (route) => json(route, 200, { roles: [] }));
  await page.route(/\/api\/calendar\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/calendars')) return json(route, 200, { calendars: [], providers: connected ? ['google'] : [], partial: false, preferences: {}, microsoftSharedAccess: null });
    return json(route, 200, { events: connected ? s.events : [], providers: connected ? ['google'] : [], partial: false });
  });

  await page.route(/\/api\/tasks(\/|\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/tasks/, '') || '/';
    const body = req.postData() ? req.postDataJSON() : undefined;
    s.calls.push({ method: req.method(), path: `/tasks${path}`, body });
    if (path === '/my-day') {
      return json(route, 200, {
        date: TODAY, timezone: 'UTC', tasks: s.tasks.filter((t) => t.myDayOn === TODAY).map(taskView),
        suggestions: s.tasks.filter((t) => t.status === 'open' && t.myDayOn && t.myDayOn < TODAY).map((t) => ({ ...t, bucket: 'earlier', reason: 'in My Day yesterday' })),
      });
    }
    if (path === '/lists') return json(route, 200, { lists: [] });
    if (path.endsWith('/comments')) return json(route, 200, { comments: [], truncated: false });
    const noteLink = /^\/([^/]+)\/notes(?:\/([^/]+))?$/.exec(path);
    if (noteLink) {
      const task = s.tasks.find((t) => t.id === noteLink[1]);
      if (!task) return json(route, 404, { error: 'Task not found' });
      if (req.method() === 'DELETE') {
        const before = s.links.length;
        s.links = s.links.filter((l) => !(l.taskId === task.id && l.noteId === noteLink[2]));
        return before === s.links.length ? json(route, 404, { error: 'Link not found' }) : json(route, 200, { unlinked: true });
      }
      let noteId = body?.noteId as string | undefined;
      if (body?.title) {
        const n = N(`n-${s.notes.length + 1}`, body.title, `${body.title}\n\n`);
        s.notes.push(n);
        noteId = n.id;
      }
      if (!s.links.some((l) => l.taskId === task.id && l.noteId === noteId)) s.links.push({ taskId: task.id, noteId: noteId as string, anchor: null });
      return json(route, 200, { note: linkedNotes(task.id).find((n) => n.id === noteId) });
    }
    if (req.method() === 'POST' && path === '/') {
      const { myDay, tz, noteId, noteAnchor, ...rest } = body ?? {};
      void tz;
      if (noteId && !s.notes.some((n) => n.id === noteId)) return json(route, 404, { error: 'Note not found', code: 'not_found' });
      const row = T(`new-${s.tasks.length + 1}`, rest.title, { ...rest, myDayOn: myDay ? TODAY : null });
      s.tasks.push(row);
      if (noteId) s.links.push({ taskId: row.id, noteId, anchor: noteAnchor ?? null });
      return json(route, 200, taskView(row));
    }
    if (req.method() === 'PATCH') {
      const row = s.tasks.find((t) => t.id === path.slice(1));
      if (!row) return json(route, 404, { error: 'Task not found' });
      const { myDay, tz, status, ...rest } = body ?? {};
      void tz;
      Object.assign(row, rest);
      if (myDay !== undefined) row.myDayOn = myDay ? TODAY : null;
      if (status !== undefined && status !== row.status) {
        const was = row.status;
        setStatus(row, status);
        // The server ticks the lines it was made from (core/tasks/note-links.ts).
        const ticked = status === 'done' ? true : was === 'done' && (status === 'open' || status === 'in_progress') ? false : null;
        if (ticked !== null) {
          for (const l of s.links.filter((x) => x.taskId === row.id && x.anchor)) {
            const n = s.notes.find((x) => x.id === l.noteId);
            if (n) n.body = setChecked(n.body, l.anchor as string, ticked);
          }
        }
      }
      return json(route, 200, taskView(row));
    }
    const one = s.tasks.find((t) => t.id === path.slice(1));
    if (req.method() === 'GET' && one) return json(route, 200, taskView(one));
    if (url.searchParams.get('status') === 'archived') return json(route, 200, { tasks: s.tasks.filter((t) => t.status === 'archived').map(taskView), page: { total: 0 } });
    return json(route, 200, { tasks: s.tasks.filter((t) => t.status !== 'archived').map(taskView), serverNow: new Date().toISOString(), done: { total: s.tasks.filter((t) => t.status === 'done').length } });
  });

  await page.route(/\/api\/notes(\/|\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/notes/, '') || '/';
    const body = req.postData() ? req.postDataJSON() : undefined;
    s.calls.push({ method: req.method(), path: `/notes${path}`, body });
    if (path === '/index') return json(route, 200, { notes: s.notes.map((n) => ({ id: n.id, title: n.title, slug: n.slug, noteKind: n.noteKind })) });
    if (path === '/tags') return json(route, 200, { tags: [] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    if (path === '/daily') {
      const date = req.method() === 'GET' ? url.searchParams.get('date') : body?.date;
      let daily = s.notes.find((n) => n.slug === `daily/${date}`);
      if (req.method() === 'GET') return json(route, 200, { note: daily ? { ...noteFull(daily), backlinks: [], outgoing: [], linkedTasks: linkedTasks(daily.id) } : null, template: dailyTemplate(date) });
      if (!daily) {
        daily = N('today-note', date, dailyTemplate(date), { slug: `daily/${date}`, noteKind: 'daily', noteDate: date });
        s.notes.unshift(daily);
      }
      return json(route, 200, { note: noteFull(daily) });
    }
    if (path === '/capture') {
      let daily = s.notes.find((n) => n.slug === `daily/${body.date}`);
      if (!daily) {
        daily = N('today-note', body.date, dailyTemplate(body.date), { slug: `daily/${body.date}`, noteKind: 'daily', noteDate: body.date });
        s.notes.unshift(daily);
      }
      daily.body = `${daily.body.replace(/\s+$/, '')}\n- 09:00 ${body.text}\n`;
      return json(route, 200, { id: daily.id, slug: daily.slug });
    }
    if (path === '/' && req.method() === 'POST') {
      const n = s.notes.find((x) => x.id === body.id);
      if (!n) return json(route, 404, { error: 'Note not found' });
      if (body.ifSha256 && body.ifSha256 !== sha(n.body)) return json(route, 409, { error: 'stale', code: 'stale', currentSha256: sha(n.body) });
      // A line's tick changed: its to-do follows.
      const was = anchors(n.body);
      for (const [anchor, checked] of anchors(body.body)) {
        if (was.get(anchor) === undefined || was.get(anchor) === checked) continue;
        const l = s.links.find((x) => x.noteId === n.id && x.anchor === anchor);
        const t = l && s.tasks.find((x) => x.id === l.taskId);
        if (t && t.status !== 'archived') setStatus(t, checked ? 'done' : 'open');
      }
      n.body = body.body;
      n.title = body.title;
      n.updatedAt = new Date().toISOString();
      return json(route, 200, { note: noteFull(n) });
    }
    if (path === '/') return json(route, 200, { notes: s.notes.filter((n) => !n.archivedAt).map(noteFull), total: s.notes.length });
    const n = s.notes.find((x) => x.id === path.slice(1));
    if (!n) return json(route, 404, { error: 'Note not found' });
    return json(route, 200, { ...noteFull(n), backlinks: [], outgoing: [], linkedTasks: linkedTasks(n.id) });
  });
  return s;
}
