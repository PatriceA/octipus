import { describe, expect, it } from 'vitest';
import { isSweepable } from './vitest-global-setup';

/**
 * The temp-directory sweep must only touch directories `mkdtempSync` made.
 *
 * `/tmp/octipus-cli` is a FIXED directory the running product creates for its
 * CLI adapters (`src/core/cli-adapters.ts:96`), not a temporary one, so a bare
 * prefix match would let `npm test` delete adapter HOME directories out from
 * under a live server.
 */
describe('the temp-directory sweep', () => {
  it('removes a directory mkdtemp made', () => {
    expect(isSweepable('octipus-pipe-loop-Ab3xY9')).toBe(true);
    expect(isSweepable('octipus-wsscoped-lKdM4r')).toBe(true);
    expect(isSweepable('octi-setup-9zQ1pK')).toBe(true);
  });

  it('spares the product’s fixed CLI directory', () => {
    expect(isSweepable('octipus-cli')).toBe(false);
  });

  it('spares a live shell sandbox’s scratch directory', () => {
    // `octipus-shell-XXXXXX` IS a mkdtemp directory, but it belongs to a
    // command that is still running — sweeping it pulls the ground out from
    // under a live process rather than reclaiming a finished test's data.
    expect(isSweepable('octipus-shell-Ab3xY9')).toBe(false);
  });

  it('spares a name that merely shares the prefix', () => {
    expect(isSweepable('octipus-data')).toBe(false);
    expect(isSweepable('octipus')).toBe(false);
    expect(isSweepable('octipus-keybindings-1787536877768-0.43.json')).toBe(false);
  });
});
