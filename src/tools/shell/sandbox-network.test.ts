import { describe, expect, test } from 'vitest';
import { resolveAllowNetwork } from './local-operations';

/**
 * Network is its own question, asked separately from shell features.
 *
 * It used to be `allowNetwork: !!options.unsafe` — "this command needs the
 * internet" inferred from "this command needs pipes". Two unrelated concerns on
 * one flag, and the consequence was that the process sandbox could not
 * realistically be switched on: `npm install`, `pip install` and `git fetch`
 * need no shell, so under `SHELL_SANDBOX=auto` they lost their network unless
 * the caller asked for shell features it did not want.
 *
 * Verified live against bubblewrap on 2026-08-29 — `getent hosts example.com`
 * exits 2 confined and 0 with `network: true`, and `touch /etc/...` is refused.
 * That needs `bwrap` on PATH, so what is pinned here is the decision itself.
 */

describe('asking for the network', () => {
  test('a plain command gets none', () => {
    expect(resolveAllowNetwork({})).toBe(false);
  });

  test('a command that asks for it gets it', () => {
    expect(resolveAllowNetwork({ allowNetwork: true })).toBe(true);
  });

  test('needing shell features does NOT grant the network', () => {
    // The regression: `useShell` used to mean "and also give it the internet".
    expect(resolveAllowNetwork({ unsafe: true })).toBe(false);
  });

  test('the two are independent in both directions', () => {
    expect(resolveAllowNetwork({ unsafe: true, allowNetwork: true })).toBe(true);
    expect(resolveAllowNetwork({ unsafe: false, allowNetwork: true })).toBe(true);
    expect(resolveAllowNetwork({ unsafe: true, allowNetwork: false })).toBe(false);
  });
});
