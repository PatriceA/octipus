/** `@` mentions of agents, skills and sessions in a real terminal, listed from the REST routes the web reads. */
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const ROUTES: Record<string, unknown> = {
  '/roles': { roles: [{ role: 'coding', description: 'Writes and changes code' }, { role: 'research', description: 'Finds things out' }] },
  '/skills': { skills: [{ id: 's1', name: 'Tech Writing', description: 'Clear documentation' }] },
  '/sessions?limit=30': { sessions: [{ id: '12345678-0000-4000-8000-000000000000', title: 'Fix the parser', updatedAt: '2026-11-20T10:00:00.000Z' }] },
};

describe.skipIf(process.platform === 'win32')('mentions in a real terminal', () => {
  test('@ lists agents, skills and sessions; the chosen one goes into the message as its token', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], { http: path => (path in ROUTES ? { body: ROUTES[path] } : undefined) });
    await tui.waitFor('connected');
    tui.send('ask @');
    await tui.waitFor('@agent:research');
    const screen = await tui.text();
    expect(screen).toContain('@skill:Tech-Writing');
    expect(screen).toContain('@session:12345678');
    tui.send('resea');
    await tui.waitFor('@agent:coding', true);
    await tui.saveScreen('mentions');
    tui.send('\t');
    await tui.waitFor('ask @agent:research');
    tui.send('to look into it');
    tui.send(KEY.Enter);
    await tui.waitFor('A streaming reply');
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'chat.send', content: 'ask @agent:research to look into it' }));
    expect(tui.requests.map(r => r.path).sort()).toEqual(['/api/roles', '/api/sessions?limit=30', '/api/skills']);
  });

  test('escape sequences in a shared skill\'s name or a session title never reach the terminal', async () => {
    const evil = '\x1b]52;c;cHduZWQ=\x07\x1b]0;pwned-title\x07\x1b[2J';
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], { http: path => ({
      '/roles': { body: { roles: [{ role: 'coding', description: `Writes code${evil}` }] } },
      '/skills': { body: { skills: [{ id: 's1', name: `Evil${evil}`, description: evil }] } },
      '/sessions?limit=30': { body: { sessions: [{ id: '12345678-0000-4000-8000-000000000000', title: `Fix${evil}` }] } },
    } as Record<string, { body: unknown }>)[path] });
    await tui.waitFor('connected');
    tui.send('@');
    await tui.waitFor('@skill:Evil');
    expect(tui.clipboardRequests).toEqual([]);
    expect(tui.rawOutput()).not.toContain('pwned-title');
    expect(tui.rawOutput()).not.toContain('cHduZWQ=');
  });

  test('a list the server refuses is said once, and the others still complete', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28, [], { http: path => (path === '/roles' ? { body: ROUTES['/roles'] } : { status: 503, body: { error: 'Database unavailable' } }) });
    await tui.waitFor('connected');
    tui.send('@cod');
    await tui.waitFor('@agent:coding');
    await tui.waitFor('the skills could not be listed (Database unavailable)');
  });
});
