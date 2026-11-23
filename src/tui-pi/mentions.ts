/**
 * `@` mentions in the composer: agents, skills and sessions, completed
 * beside pi-tui's `@file` completion.
 *
 * Typing `@` and a few letters lists the matching agents (the roles the
 * root agent can delegate to), skills and recent sessions above the
 * matching files; choosing one inserts a token the agent reads as plain
 * text in the message: `@agent:coding`, `@skill:<name>`,
 * `@session:<id prefix>`. The server gives the tokens no meaning of their
 * own: they name the thing for the agent, which decides what to do with it.
 *
 * The lists come from the REST routes the web reads (`/roles`, `/skills`,
 * `/sessions`) as the signed-in user, fetched on the first `@` and kept for
 * a minute. A list that fails to load is reported once through `onError`
 * and left out; the others and the files still complete.
 */
import { type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, fuzzyFilter } from '@/tui-kit';

export type MentionKind = 'agent' | 'skill' | 'session';

export interface Mention { kind: MentionKind; token: string; label: string; description: string }

/** How long a loaded list is used before it is fetched again. */
const TTL_MS = 60_000;
/** Mentions shown at most, above the files. */
const MAX_MENTIONS = 12;
/** A mention token: `@` and a kind, then the name. */
const MENTION_TOKEN = /^@(agent|skill|session):\S+$/;
/** The `@` word before the cursor that mentions complete: letters, digits, `.`, `_`, `:` and `-` (a `/` makes it a path). */
const MENTION_PREFIX = /(?:^|[\s([{<`])(@[\w.:-]*)$/u;

/** A name as one token: whitespace becomes `-`. */
const slug = (name: string) => name.trim().replace(/\s+/g, '-');

interface RoleRow { role: string; description?: string }
interface SkillRow { id: string; name: string; description?: string }
interface SessionRow { id: string; title?: string | null; channelType?: string; updatedAt?: string }

/** Turn the routes' answers into mentions; rows of an unexpected shape are skipped. */
export function roleMentions(body: unknown): Mention[] {
  const rows = (body as { roles?: RoleRow[] } | null)?.roles;
  if (!Array.isArray(rows)) throw new Error('the server sent no role list');
  return rows.filter(r => typeof r?.role === 'string').map(r => ({
    kind: 'agent', token: `@agent:${r.role}`, label: `@agent:${r.role}`, description: r.description?.split('\n')[0] || 'Agent',
  }));
}

export function skillMentions(body: unknown): Mention[] {
  const rows = (body as { skills?: SkillRow[] } | null)?.skills;
  if (!Array.isArray(rows)) throw new Error('the server sent no skill list');
  return rows.filter(r => typeof r?.name === 'string' && r.name.trim()).map(r => ({
    kind: 'skill', token: `@skill:${slug(r.name)}`, label: `@skill:${slug(r.name)}`, description: r.description?.split('\n')[0] || 'Skill',
  }));
}

export function sessionMentions(body: unknown, current: string): Mention[] {
  const rows = (body as { sessions?: SessionRow[] } | null)?.sessions;
  if (!Array.isArray(rows)) throw new Error('the server sent no session list');
  return rows.filter(r => typeof r?.id === 'string' && r.id !== current).map(r => ({
    kind: 'session', token: `@session:${r.id.slice(0, 8)}`, label: `@session:${r.id.slice(0, 8)}`,
    description: `${(r.title ?? '').replace(/\s+/g, ' ').trim() || '(untitled)'}${r.updatedAt ? ` · ${r.updatedAt.slice(0, 10)}` : ''}`,
  }));
}

/** The three lists, loaded on demand and kept for `TTL_MS`. */
export class MentionSource {
  private cache: { at: number; mentions: Promise<Mention[]> } | null = null;

  constructor(
    private readonly getJson: <T>(path: string) => Promise<T>,
    private readonly sessionId: () => string,
    private readonly onError: (text: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Promise<Mention[]> {
    if (this.cache && this.now() - this.cache.at < TTL_MS) return this.cache.mentions;
    const load = async (kind: string, path: string, read: (body: unknown) => Mention[]): Promise<Mention[]> => {
      try {
        return read(await this.getJson<unknown>(path));
      } catch (error) {
        this.onError(`@ mentions: the ${kind} could not be listed (${error instanceof Error ? error.message : String(error)}); they are left out for a minute.`);
        return [];
      }
    };
    const mentions = Promise.all([
      load('agents', '/roles', roleMentions),
      load('skills', '/skills', skillMentions),
      load('sessions', '/sessions?limit=30', body => sessionMentions(body, this.sessionId())),
    ]).then(lists => lists.flat());
    this.cache = { at: this.now(), mentions };
    return mentions;
  }
}

/**
 * pi-tui's provider (slash commands, `@file`, paths) with mentions put in
 * front of the files for an `@` word.
 */
export class MentionAutocompleteProvider implements AutocompleteProvider {
  constructor(private readonly inner: AutocompleteProvider, private readonly mentions: () => Promise<Mention[]>) {}

  get triggerCharacters(): string[] | undefined { return this.inner.triggerCharacters; }

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const word = MENTION_PREFIX.exec(before)?.[1];
    const [files, mentions] = await Promise.all([
      this.inner.getSuggestions(lines, cursorLine, cursorCol, options),
      word !== undefined ? this.mentions() : Promise.resolve([]),
    ]);
    if (word === undefined || options.signal.aborted) return files;
    const query = word.slice(1);
    const matched = query ? fuzzyFilter(mentions, query, m => `${m.token.slice(1)} ${m.description}`) : mentions;
    const items: AutocompleteItem[] = matched.slice(0, MAX_MENTIONS).map(m => ({ value: m.token, label: m.label, description: m.description }));
    if (files && files.prefix === word) items.push(...files.items);
    return items.length ? { items, prefix: word } : files;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (!MENTION_TOKEN.test(item.value) || !prefix.startsWith('@')) return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    const line = lines[cursorLine] ?? '';
    const start = cursorCol - prefix.length;
    const next = [...lines];
    next[cursorLine] = `${line.slice(0, start)}${item.value} ${line.slice(cursorCol)}`;
    return { lines: next, cursorLine, cursorCol: start + item.value.length + 1 };
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }
}
