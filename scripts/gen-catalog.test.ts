/**
 * The catalog generator's own checks.
 *
 * These pin the cases that were wrong in the first draft, because each of them
 * produced a catalog that read as coverage while omitting or inventing things:
 *
 * - A commented-out mount counted as a live mount, which would have hidden the
 *   exact defect the catalog exists to surface (commenting out a `.use` is how
 *   a route stops being reachable).
 * - `getGatewayHub().publishEvent({...})` resolved the getter's parenthesis
 *   instead of the call's, so the payload came back empty and every event
 *   published that way looked unpublished.
 * - Indirect event types swept up the operand they were compared against, so a
 *   type nobody declares appeared as "published but not declared".
 * - A `Map.get(id)` inside a handler counted as an unresolvable route.
 */
import { describe, expect, test } from 'bun:test';
import {
  blankComments,
  collectEvents,
  collectRoutes,
  hasSecondArgument,
  matchingParen,
  mountPrefixes,
  patternCovers,
  resolveEventTypes,
} from './gen-catalog';

describe('blankComments', () => {
  test('blanks comments, keeps strings, and never moves an offset', () => {
    const src = "const a = 1; // .use(ghost)\nconst b = 'text';";
    const out = blankComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('.use(ghost)');
    // Strings survive: the route patterns anchor on their quotes, and the path
    // is read back from the original text at the same index.
    expect(out).toContain("'text'");
    expect(out.indexOf('const b')).toBe(src.indexOf('const b'));
  });

  test('a comment marker inside a string does not start a comment', () => {
    const src = "const u = 'https://x/y'; const live = 1;";
    expect(blankComments(src)).toContain('const live = 1;');
  });

  test('a regex literal containing a quote does not blind the scan to later comments', () => {
    // `/['"]/` reads as a `/` followed by a quote to a scanner with no
    // regex-literal state, which then runs to the NEXT quote anywhere in the
    // file. Everything in between is stepped over rather than examined — so a
    // commented-out mount inside that span never gets blanked and reads as
    // live, which is exactly the defect the HTTP catalog exists to surface.
    const src = "const META = /['\"]/;\n// app.use(ghostRoutes)\nconst s = 'tail';";
    const out = blankComments(src);
    expect(out).not.toContain('.use(ghostRoutes)');
    expect(out.length).toBe(src.length);
    // And the same source read through the mount scanner agrees.
    expect(mountPrefixes(src).has('ghostRoutes')).toBe(false);
  });

  test('a division is not mistaken for a regex', () => {
    const src = 'const half = total / 2; app.use(realRoutes);';
    expect(blankComments(src)).toContain('.use(realRoutes)');
    expect(mountPrefixes(src).has('realRoutes')).toBe(true);
  });

  test('a block comment spanning lines keeps its newlines', () => {
    const src = 'a\n/* one\n   two */\nb';
    const out = blankComments(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('two');
  });
});

describe('matchingParen', () => {
  test('ignores parens inside strings and comments', () => {
    const src = 'f((\'a)\' /* ) */ , `)`))';
    expect(matchingParen(src, 1)).toBe(src.length - 1);
  });
});

describe('mountPrefixes', () => {
  const server = `
    app.group('/api', (app) => app.use(alphaRoutes).use(betaRoutes))
    app.use(rootRoutes)
    // app.use(ghostRoutes)
  `;

  test('a route inside a group gets the group prefix, one outside gets none', () => {
    const m = mountPrefixes(server);
    expect(m.get('alphaRoutes')).toBe('/api');
    expect(m.get('betaRoutes')).toBe('/api');
    expect(m.get('rootRoutes')).toBe('');
  });

  test('a commented-out mount is not a mount', () => {
    expect(mountPrefixes(server).has('ghostRoutes')).toBe(false);
  });
});

describe('hasSecondArgument', () => {
  test('a lone argument is not a route registration', () => {
    expect(hasSecondArgument('params.id')).toBe(false);
    expect(hasSecondArgument('`key:${id}`')).toBe(false);
  });
  test('nested commas do not count', () => {
    expect(hasSecondArgument('{ a: 1, b: 2 }')).toBe(false);
    expect(hasSecondArgument("'/x', handler")).toBe(true);
  });
});

describe('resolveEventTypes', () => {
  const declared = ['agent.action', 'agent.event', 'chat.response'];

  test('a direct literal resolves to itself, undeclared or not', () => {
    expect(resolveEventTypes("'chat.response'", '', declared)).toEqual(['chat.response']);
    expect(resolveEventTypes("'not.declared'", '', declared)).toEqual(['not.declared']);
  });

  test('a local const resolves to its declared branches, not the compared operand', () => {
    const src = "const subtype = event.type === 'action' ? 'agent.action' : 'agent.event';";
    expect(resolveEventTypes('subtype', src, declared).sort()).toEqual(['agent.action', 'agent.event']);
  });

  test('a same-file mapper resolves to what it returns', () => {
    const src = `
      function mapType(t: string) {
        switch (t) {
          case 'a': return 'chat.response';
          default: return 'agent.event';
        }
      }
      function other() { return 'nope'; }
    `;
    expect(resolveEventTypes('mapType(x)', src, declared).sort()).toEqual(['agent.event', 'chat.response']);
  });

  test('an unresolvable expression yields nothing rather than a guess', () => {
    expect(resolveEventTypes('someImported(x)', '', declared)).toEqual([]);
  });
});

describe('patternCovers', () => {
  test('wildcards cover their namespace and nothing else', () => {
    expect(patternCovers('*', 'anything')).toBe(true);
    expect(patternCovers('swarm.*', 'swarm.node_spawned')).toBe(true);
    expect(patternCovers('swarm.*', 'agent.blocked')).toBe(false);
    expect(patternCovers('swarm.node_spawned', 'swarm.node_spawned')).toBe(true);
  });
});

describe('against the real repository', () => {
  test('the HTTP surface is non-trivial and fully resolved', () => {
    const { routes, unresolved } = collectRoutes();
    // A generator that silently produced nothing would still pass a
    // "no crash" test; this fails if the extraction stops working.
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.every((r) => r.path.startsWith('/'))).toBe(true);
    expect(unresolved).toBe(0);
  });

  test('every mounted route object is reachable', () => {
    expect(collectRoutes().unmounted).toEqual([]);
  });

  test('gateway publishers are found, and the scheduler bus is not mistaken for one', () => {
    const { declared, produced } = collectEvents();
    expect(declared).toContain('swarm.node_spawned');
    const types = new Set(produced.map((p) => p.type));
    expect(types.has('swarm.node_spawned')).toBe(true);
    // `Scheduler` has a private `publishEvent` onto a Redis channel. Its task
    // lifecycle names must never appear in the gateway matrix.
    for (const taskEvent of ['created', 'started', 'completed', 'failed', 'retried']) {
      expect(types.has(taskEvent)).toBe(false);
    }
  });

  test('nothing is published that the union does not declare', () => {
    const { declared, produced } = collectEvents();
    const undeclared = [...new Set(produced.map((p) => p.type))].filter((t) => !declared.includes(t));
    expect(undeclared).toEqual([]);
  });
});
