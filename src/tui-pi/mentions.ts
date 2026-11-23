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
 * a minute for the same workspace, account and session. A list that fails
 * to load is reported through `onError` (at most once a minute) and left
 * out; the others and the files still complete. Files never wait more than
 * `MENTION_WAIT_MS` for the lists.
 *
 * Every name and description is someone else's text (a shared skill, a
 * session title): it goes through `displayLine` before it is shown, and a
 * token is only offered when it holds nothing but printable characters.
 */
import { type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, displayLine, fuzzyFilter } from '@/tui-kit';

export type MentionKind = 'agent' | 'skill' | 'session';

export interface Mention { kind: MentionKind; token: string; label: string; description: string }

/** How long a loaded list is used before it is fetched again. */
const TTL_MS = 60_000;
/** How long file completion waits for the lists on the first `@`; past it the files come alone and the lists the next time. */
export const MENTION_WAIT_MS = 1500;
/** Mentions shown at most, above the files. */
const MAX_MENTIONS = 12;
/** A mention token: `@` and a kind, then the name. */
const MENTION_TOKEN = /^@(agent|skill|session):\S+$/;
/** The `@` word before the cursor that mentions complete: letters, digits, `.`, `_`, `:` and `-` (a `/` makes it a path). */
const MENTION_PREFIX = /(?:^|[\s([{<`])(@[\w.:-]*)$/u;

/** A name as one token: printable text only, whitespace becomes `-`. */
const slug = (name: string) => displayLine(name).replace(/\s+/g, '-');
/** A token that holds only printable, non-space characters; anything else is not offered. */
const PRINTABLE_TOKEN = /^@(agent|skill|session):[^\s\p{Cc}\p{Cf}]+$/u;
const mention = (kind: MentionKind, name: string, description: string): Mention | null => {
  const token = `@${kind}:${slug(name)}`;
  return PRINTABLE_TOKEN.test(token) ? { kind, token, label: token, description: displayLine(description) } : null;
};
const present = (m: Mention | null): m is Mention => m !== null;
const firstLine = (text: string | null | undefined) => (text ?? '').split('\n')[0] ?? '';

interface RoleRow { role: string; description?: string }
interface SkillRow { id: string; name: string; description?: string }
interface SessionRow { id: string; title?: string | null; channelType?: string; updatedAt?: string }

/** Turn the routes' answers into mentions; rows of an unexpected shape are skipped. */
export function roleMentions(body: unknown): Mention[] {
  const rows = (body as { roles?: RoleRow[] } | null)?.roles;
  if (!Array.isArray(rows)) throw new Error('the server sent no role list');
  return rows.filter(r => typeof r?.role === 'string').map(r => mention('agent', r.role, firstLine(r.description) || 'Agent')).filter(present);
}

export function skillMentions(body: unknown): Mention[] {
  const rows = (body as { skills?: SkillRow[] } | null)?.skills;
  if (!Array.isArray(rows)) throw new Error('the server sent no skill list');
  return rows.filter(r => typeof r?.name === 'string').map(r => mention('skill', r.name, firstLine(r.description) || 'Skill')).filter(present);
}

export function sessionMentions(body: unknown, current: string): Mention[] {
  const rows = (body as { sessions?: SessionRow[] } | null)?.sessions;
  if (!Array.isArray(rows)) throw new Error('the server sent no session list');
  return rows.filter(r => typeof r?.id === 'string' && r.id !== current)
    .map(r => mention('session', r.id.slice(0, 8), `${displayLine(r.title ?? '') || '(untitled)'}${typeof r.updatedAt === 'string' ? ` · ${r.updatedAt.slice(0, 10)}` : ''}`))
    .filter(present);
}

/** The three lists, loaded on demand and kept for `TTL_MS` while the workspace, account and session stay the same. */
export class MentionSource {
  private cache: { at: number; scope: string; mentions: Promise<Mention[]> } | null = null;

  constructor(
    private readonly getJson: <T>(path: string) => Promise<T>,
    private readonly sessionId: () => string,
    private readonly onError: (text: string) => void,
    /** Who and where the lists are for (workspace and account); a change fetches them again. */
    private readonly scope: () => string = () => '',
    private readonly now: () => number = Date.now,
  ) {}

  list(): Promise<Mention[]> {
    const scope = `${this.scope()}\u0000${this.sessionId()}`;
    if (this.cache && this.cache.scope === scope && this.now() - this.cache.at < TTL_MS) return this.cache.mentions;
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
    this.cache = { at: this.now(), scope, mentions };
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
    // The lists never hold the files back for long: past the wait the files come alone.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = word === undefined ? Promise.resolve([]) : Promise.race([
      this.mentions(),
      new Promise<Mention[]>(resolve => { timer = setTimeout(() => resolve([]), MENTION_WAIT_MS); }),
    ]);
    const [files, mentions] = await Promise.all([this.inner.getSuggestions(lines, cursorLine, cursorCol, options), waited]);
    clearTimeout(timer);
    if (word === undefined || options.signal.aborted) return files;
    const query = word.slice(1);
    const matched = query ? fuzzyFilter(mentions, query, m => `${m.token.slice(1)} ${m.description}`) : mentions;
    const items: AutocompleteItem[] = matched.slice(0, MAX_MENTIONS).map(m => ({ value: m.token, label: m.label, description: m.description }));
    if (files && files.prefix === word) items.push(...files.items);
    return items.length ? { items, prefix: word } : files;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (!MENTION_TOKEN.test(item.value) || !prefix.startsWith('@')) return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    // Never put a control character into the composer, whatever the list held.
    if (!PRINTABLE_TOKEN.test(item.value)) return { lines, cursorLine, cursorCol };
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
