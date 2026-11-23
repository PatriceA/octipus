/** `@` mentions of agents, skills and sessions beside file completion (docs/plans/tui-modernization.md §5.1, "Mentions"). */
import { describe, expect, test, vi } from 'vitest';
import type { AutocompleteProvider } from '@/tui-kit';
import { type Mention, MentionAutocompleteProvider, MentionSource, roleMentions, sessionMentions, skillMentions } from './mentions';

const ROUTES: Record<string, unknown> = {
  '/roles': { roles: [{ role: 'coding', description: 'Writes and changes code\nmore' }, { role: 'research', description: '' }] },
  '/skills': { skills: [{ id: 'aaaa', name: 'Tech Writing', description: 'Clear docs' }, { id: 'bbbb', name: '' }] },
  '/sessions?limit=30': { sessions: [
    { id: '12345678-0000-4000-8000-000000000000', title: '  Fix the\nparser ', updatedAt: '2026-11-20T10:00:00.000Z' },
    { id: 'current0-0000-4000-8000-000000000000', title: 'This one' },
  ] },
};

const signal = new AbortController().signal;

/** A file provider that offers one file for any `@` word. */
const files: AutocompleteProvider = {
  getSuggestions: async (lines, line, col) => {
    const word = /@\S*$/.exec((lines[line] ?? '').slice(0, col))?.[0];
    return word ? { items: [{ value: '@src/coder.ts', label: 'coder.ts', description: 'src' }], prefix: word } : null;
  },
  applyCompletion: (lines, line, col, item, prefix) => {
    const text = lines[line] ?? '';
    return { lines: [`${text.slice(0, col - prefix.length)}${item.value} ${text.slice(col)}`], cursorLine: line, cursorCol: col - prefix.length + item.value.length + 1 };
  },
};

function source(routes = ROUTES) {
  const errors: string[] = [];
  const getJson = vi.fn(async (path: string) => {
    if (!(path in routes)) throw new Error('HTTP 500');
    return routes[path];
  });
  let now = 0;
  const mentions = new MentionSource(getJson as <T>(path: string) => Promise<T>, () => 'current0-0000-4000-8000-000000000000', text => errors.push(text), () => now);
  return { mentions, getJson, errors, advance: (ms: number) => { now += ms; } };
}

describe('the lists', () => {
  test('roles become agents, skills keep their name as one token, sessions their id prefix and title; this session is left out', async () => {
    const { mentions } = source();
    const all = await mentions.list();
    expect(all.map(m => m.token)).toEqual(['@agent:coding', '@agent:research', '@skill:Tech-Writing', '@session:12345678']);
    expect(all.find(m => m.kind === 'agent')?.description).toBe('Writes and changes code');
    expect(all.find(m => m.kind === 'session')?.description).toBe('Fix the parser · 2026-11-20');
  });

  test('fetched once a minute; a list that fails is reported and left out, the others still come', async () => {
    const { mentions, getJson, errors, advance } = source({ '/roles': ROUTES['/roles'], '/sessions?limit=30': { nope: true } });
    const all = await mentions.list();
    await mentions.list();
    expect(getJson).toHaveBeenCalledTimes(3);
    expect(all.map(m => m.kind)).toEqual(['agent', 'agent']);
    expect(errors).toEqual([
      '@ mentions: the skills could not be listed (HTTP 500); they are left out for a minute.',
      '@ mentions: the sessions could not be listed (the server sent no session list); they are left out for a minute.',
    ]);
    advance(61_000);
    await mentions.list();
    expect(getJson).toHaveBeenCalledTimes(6);
  });

  test('a route that answers something else is an error, not an empty list', () => {
    expect(() => roleMentions({})).toThrow('no role list');
    expect(() => skillMentions(null)).toThrow('no skill list');
    expect(() => sessionMentions({ sessions: 'x' }, '')).toThrow('no session list');
  });
});

describe('the completion', () => {
  const list: Mention[] = [
    { kind: 'agent', token: '@agent:coding', label: '@agent:coding', description: 'Writes code' },
    { kind: 'skill', token: '@skill:Tech-Writing', label: '@skill:Tech-Writing', description: 'Docs' },
    { kind: 'session', token: '@session:12345678', label: '@session:12345678', description: 'Fix the parser' },
  ];
  const provider = new MentionAutocompleteProvider(files, async () => list);

  test('an @ word lists the matching mentions above the files', async () => {
    const result = await provider.getSuggestions(['ask @cod'], 0, 8, { signal });
    expect(result?.prefix).toBe('@cod');
    expect(result?.items.map(i => i.value)).toEqual(['@agent:coding', '@src/coder.ts']);
    const all = await provider.getSuggestions(['@'], 0, 1, { signal });
    expect(all?.items.map(i => i.value)).toEqual(['@agent:coding', '@skill:Tech-Writing', '@session:12345678', '@src/coder.ts']);
    const kind = await provider.getSuggestions(['see @session:'], 0, 13, { signal });
    expect(kind?.items[0]?.value).toBe('@session:12345678');
  });

  test('choosing a mention replaces the @ word with its token and a space; a file goes through the file provider', () => {
    expect(provider.applyCompletion(['ask @cod now'], 0, 8, { value: '@agent:coding', label: '' }, '@cod'))
      .toEqual({ lines: ['ask @agent:coding  now'], cursorLine: 0, cursorCol: 18 });
    expect(provider.applyCompletion(['@cod'], 0, 4, { value: '@src/coder.ts', label: '' }, '@cod').lines).toEqual(['@src/coder.ts ']);
  });

  test('not an @ word (a path, a command, plain text): only what the file provider says', async () => {
    const mentions = vi.fn(async () => list);
    const plain = new MentionAutocompleteProvider(files, mentions);
    expect(await plain.getSuggestions(['/hel'], 0, 4, { signal })).toBeNull();
    expect((await plain.getSuggestions(['@src/co'], 0, 7, { signal }))?.items.map(i => i.value)).toEqual(['@src/coder.ts']);
    expect(await plain.getSuggestions(['mail@exa'], 0, 8, { signal })).toEqual({ items: [{ value: '@src/coder.ts', label: 'coder.ts', description: 'src' }], prefix: '@exa' });
    expect(mentions).not.toHaveBeenCalled();
  });
});
