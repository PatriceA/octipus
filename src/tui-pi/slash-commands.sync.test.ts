import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { CommandRegistry, registerBuiltinCommands } from '@/core/gateway/commands';
import { OCTIPUS_SLASH_COMMANDS } from './slash-commands';

/**
 * The composer's autocomplete list is static; the gateway's registry is the
 * truth. Neither side may gain or lose a command without the other — `/persona`
 * sat in the registry for months while the TUI never offered it.
 */
const HIDDEN = new Set(['work-plan-status']); // internal poll, not a user command

test('gateway slash entries mirror the registry (names and aliases)', () => {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const registered = new Map(registry.getAvailable('system').map((c) => [c.name, [...c.aliases].sort()]));
  const listed = new Map(OCTIPUS_SLASH_COMMANDS.filter((c) => c.source === 'gateway').map((c) => [c.name, [...(c.aliases ?? [])].sort()]));

  const missingFromTui = [...registered.keys()].filter((n) => !HIDDEN.has(n) && !listed.has(n));
  const unknownToGateway = [...listed.keys()].filter((n) => !registered.has(n));
  expect({ missingFromTui, unknownToGateway }).toEqual({ missingFromTui: [], unknownToGateway: [] });
  for (const [name, aliases] of listed) expect({ name, aliases }).toEqual({ name, aliases: registered.get(name) });
});

test('TUI-local entries are exactly the cases of handleCommand in app.ts', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'app.ts'), 'utf8');
  const body = source.slice(source.indexOf('private handleCommand('));
  const cases = [...body.matchAll(/^\s+case '([a-z-]+)':/gm)].map((m) => m[1]).sort();
  const local = OCTIPUS_SLASH_COMMANDS.filter((c) => c.source === 'tui').map((c) => c.name).sort();
  expect(cases.length).toBeGreaterThan(5);
  expect(local).toEqual(cases);
});
