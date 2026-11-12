import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { canonicalJson, hashContributions, hasContributions } from './contributions/approval';
import { cronMatches, cronProblem, parseCron } from './contributions/cron';
import { expandInput, resultText } from './contributions/call';
import { ManifestError, parseManifest } from './manifest';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'contrib-plugin', 'octipus-plugin.json'), 'utf8'));

function problems(value: unknown): string[] {
  try {
    parseManifest(value);
  } catch (err) {
    if (err instanceof ManifestError) return err.problems;
    throw err;
  }
  throw new Error('expected a ManifestError');
}

describe('plugin manifest contributions', () => {
  test('the fixture fits the contract', () => {
    const m = parseManifest(FIXTURE);
    expect(m.commands?.[0]).toMatchObject({ name: 'greet', tool: 'hello' });
    expect(m.schedules?.map((s) => s.id)).toEqual(['tick', 'write-tick']);
    expect(m.events?.[0].on).toBe('chat.response');
    expect(m.prompt).toEqual({ file: 'prompt.md', roles: ['general'] });
    expect(m.context?.tool).toBe('ctx');
  });

  test('every contribution must name a declared tool', () => {
    const found = problems({
      ...FIXTURE,
      commands: [{ name: 'greet', tool: 'nope', description: 'x' }],
      schedules: [{ id: 'tick', cron: '* * * * *', tool: 'missing' }],
      events: [{ on: 'chat.response', tool: 'gone' }],
      context: { tool: 'absent' },
    });
    expect(found).toEqual(expect.arrayContaining([
      'commands.greet: "nope" is not one of the package\'s declared tools',
      'schedules.tick: "missing" is not one of the package\'s declared tools',
      'events.chat.response: "gone" is not one of the package\'s declared tools',
      'context: "absent" is not one of the package\'s declared tools',
    ]));
  });

  test('the context tool must be a read', () => {
    expect(problems({ ...FIXTURE, context: { tool: 'record' } })).toEqual([
      'context: "record" must declare effect "read" (it runs before every turn, with nobody to approve it)',
    ]);
  });

  test('names, ids and event pairs are unique; cron expressions parse', () => {
    const found = problems({
      ...FIXTURE,
      commands: [{ name: 'greet', tool: 'hello', description: 'a' }, { name: 'greet', tool: 'hello', description: 'b' }],
      schedules: [{ id: 'tick', cron: '61 * * * *', tool: 'hello' }, { id: 'tick', cron: '* * * * *', tool: 'hello' }],
      events: [{ on: 'chat.response', tool: 'hello' }, { on: 'chat.response', tool: 'hello' }],
    });
    expect(found).toContain('commands: "greet" is declared twice');
    expect(found).toContain('schedules: "tick" is declared twice');
    expect(found.some((p) => p.startsWith('schedules.tick: cron minute'))).toBe(true);
    expect(found).toContain('events: "chat.response" → "hello" is declared twice');
  });

  test('only allowlisted events; command names are slugs; prompt files stay in the package', () => {
    expect(problems({ ...FIXTURE, events: [{ on: 'permission.request', tool: 'hello' }] }).join(' ')).toContain('events: "on" is one of chat.response');
    expect(problems({ ...FIXTURE, commands: [{ name: 'Greet!', tool: 'hello', description: 'x' }] }).join(' ')).toContain('commands: a name is lower-case');
    for (const file of ['../outside.md', '/etc/motd.md', 'a/../b.md', './prompt.md', 'prompt.txt', '.hidden.md']) {
      expect(problems({ ...FIXTURE, prompt: { file } }).join(' '), file).toContain('prompt: file is a relative path');
    }
    expect(problems({ ...FIXTURE, prompt: { file: 'docs/agent.md', roles: [] } }).join(' ')).toMatch(/roles/);
    expect(parseManifest({ ...FIXTURE, prompt: { file: 'docs/agent.md' } }).prompt).toEqual({ file: 'docs/agent.md' });
  });

  test('an input template is bounded', () => {
    expect(problems({ ...FIXTURE, schedules: [{ id: 'big', cron: '* * * * *', tool: 'hello', input: { text: 'x'.repeat(5000) } }] }).join(' ')).toContain('input: at most');
  });
});

describe('plugin schedule cron', () => {
  test('fields, ranges, steps and lists', () => {
    const at = (iso: string) => new Date(iso);
    const every15 = parseCron('*/15 * * * *');
    expect(cronMatches(every15, at('2026-11-10T10:30:00Z'))).toBe(true);
    expect(cronMatches(every15, at('2026-11-10T10:31:00Z'))).toBe(false);
    const weekdays9 = parseCron('0 9 * * 1-5');
    expect(cronMatches(weekdays9, at('2026-11-10T09:00:00Z'))).toBe(true); // a Tuesday
    expect(cronMatches(weekdays9, at('2026-11-08T09:00:00Z'))).toBe(false); // a Sunday
    const sunday = parseCron('0 0 * * 7');
    expect(cronMatches(sunday, at('2026-11-08T00:00:00Z'))).toBe(true);
    // Both day fields restricted: either matches.
    const either = parseCron('0 0 1 * 0');
    expect(cronMatches(either, at('2026-12-01T00:00:00Z'))).toBe(true);
    expect(cronMatches(either, at('2026-11-08T00:00:00Z'))).toBe(true);
    expect(cronMatches(either, at('2026-11-10T00:00:00Z'))).toBe(false);
    expect(cronMatches(parseCron('5,10-12/2 * * * *'), at('2026-11-10T10:12:00Z'))).toBe(true);
  });

  test('a bad expression says why', () => {
    expect(cronProblem('* * * *')).toMatch(/five fields/);
    expect(cronProblem('* 24 * * *')).toMatch(/hour/);
    expect(cronProblem('* * 0 * *')).toMatch(/day of month/);
    expect(cronProblem('*/0 * * * *')).toMatch(/step/);
    expect(cronProblem('mon * * * *')).toMatch(/minute/);
    expect(cronProblem('0 9 * * 1-5')).toBeNull();
  });
});

describe('contribution calls', () => {
  test('"$args" is replaced wherever it is a whole value', () => {
    expect(expandInput({ text: '$args', nested: { list: ['$args', 'x'] }, keep: 'a $args b', n: 1 }, 'hi there'))
      .toEqual({ text: 'hi there', nested: { list: ['hi there', 'x'] }, keep: 'a $args b', n: 1 });
  });

  test('result text and errors', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: '' }, { type: 'text', text: 'b' }] })).toEqual({ text: 'a\nb', isError: false });
    expect(resultText({ content: [{ type: 'text', text: 'no' }], isError: true })).toEqual({ text: 'no', isError: true });
    expect(resultText({ content: [{ type: 'text', text: 'x'.repeat(10_000) }] }).text).toHaveLength(8_000);
  });
});

describe('contributions hash', () => {
  test('canonical JSON: keys sorted at every level, undefined members left out, arrays kept in order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined, x: 'q' }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"x":"q","z":1}]},"b":1}');
  });

  test('the same contributions hash alike whatever the key order; anything else that changes them changes it', () => {
    const m = parseManifest(FIXTURE);
    const reordered = parseManifest({
      context: FIXTURE.context, ...FIXTURE,
      commands: FIXTURE.commands.map((c: Record<string, unknown>) => ({ input: c.input, description: c.description, tool: c.tool, name: c.name })),
    });
    const prompt = new TextEncoder().encode('Use the hello tool.\n');
    const h = hashContributions(m, prompt);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashContributions(reordered, prompt)).toBe(h);
    // Tools, version and other fields are not part of it.
    expect(hashContributions({ ...m, version: '9.9.9', description: 'other' }, prompt)).toBe(h);
    // The prompt bytes, a schedule, an event, the context roles are.
    expect(hashContributions(m, new TextEncoder().encode('Use the hello tool!\n'))).not.toBe(h);
    expect(hashContributions(m, null)).not.toBe(h);
    expect(hashContributions({ ...m, schedules: [{ id: 'tick', cron: '0 * * * *', tool: 'hello' }] }, prompt)).not.toBe(h);
    expect(hashContributions({ ...m, events: [] }, prompt)).not.toBe(h);
    expect(hashContributions({ ...m, context: { tool: 'ctx', roles: ['general'] } }, prompt)).not.toBe(h);
    // An empty list hashes as none.
    expect(hashContributions({ ...m, commands: [] }, prompt)).toBe(hashContributions({ ...m, commands: undefined }, prompt));
  });

  test('a manifest with no contributions has none to approve', () => {
    expect(hasContributions({ tools: {} } as never)).toBe(false);
    expect(hasContributions({ commands: [] } as never)).toBe(false);
    expect(hasContributions({ prompt: { file: 'a.md' } } as never)).toBe(true);
  });
});
