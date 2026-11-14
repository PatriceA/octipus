/**
 * Capability gates (docs/MODULES.md → Capability gates): unknown is off,
 * a resolver decides each capability, a flip reaches listeners, a resolver
 * that throws leaves that capability off with the error as its reason.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  assertCapability,
  CapabilityNotConfiguredError,
  capabilitiesMet,
  capabilityOffMessage,
  capabilityViews,
  firstOffCapability,
  isCapabilityOn,
  onCapabilitiesChanged,
  refreshCapabilities,
  resetCapabilitiesForTest,
  setCapabilitiesForTest,
  setCapabilityResolver,
} from './gates';
import { CAPABILITIES } from '@/shared/capabilities';

const allOff = () => setCapabilitiesForTest(Object.fromEntries(CAPABILITIES.map((c) => [c, false])));

describe('capability gates', () => {
  beforeEach(() => resetCapabilitiesForTest());
  afterEach(() => setCapabilitiesForTest(Object.fromEntries(CAPABILITIES.map((c) => [c, true]))));

  test('before the first refresh every capability is off (unknown is not configured)', () => {
    for (const cap of CAPABILITIES) expect(isCapabilityOn(cap)).toBe(false);
    expect(capabilityViews().every((v) => !v.on && v.reason === 'not checked yet')).toBe(true);
  });

  test('requires lists: met only when every capability is on; an empty list is always met', () => {
    allOff();
    setCapabilitiesForTest({ embedding: true });
    expect(capabilitiesMet(undefined)).toBe(true);
    expect(capabilitiesMet([])).toBe(true);
    expect(capabilitiesMet(['embedding'])).toBe(true);
    expect(capabilitiesMet(['embedding', 'see'])).toBe(false);
    expect(firstOffCapability(['embedding', 'see', 'hear'])).toBe('see');
  });

  test('assertCapability throws a typed, explained error', () => {
    allOff();
    expect(() => assertCapability('embedding')).toThrow(CapabilityNotConfiguredError);
    try {
      assertCapability('embedding');
    } catch (err) {
      expect((err as CapabilityNotConfiguredError).code).toBe('capability_not_configured');
      expect((err as Error).message).toMatch(/embedding model/);
    }
    expect(capabilityOffMessage('see')).toMatch(/do not retry/);
  });

  test('refresh asks each resolver; a throwing resolver leaves that capability off with its reason', async () => {
    for (const cap of CAPABILITIES) setCapabilityResolver(cap, async () => ({ on: false, reason: 'nope' }));
    setCapabilityResolver('embedding', async () => ({ on: true }));
    setCapabilityResolver('see', async () => { throw new Error('registry down'); });
    const snap = await refreshCapabilities();
    expect(snap.embedding.on).toBe(true);
    expect(snap.see).toEqual({ on: false, reason: 'could not be checked: registry down' });
    expect(isCapabilityOn('embedding')).toBe(true);
    expect(isCapabilityOn('see')).toBe(false);
  });

  test('a flip reaches listeners with the new and the previous snapshot; no flip, no call', async () => {
    for (const cap of CAPABILITIES) setCapabilityResolver(cap, async () => ({ on: false }));
    await refreshCapabilities();
    const listener = vi.fn();
    const off = onCapabilitiesChanged(listener);
    await refreshCapabilities();
    expect(listener).not.toHaveBeenCalled();
    setCapabilityResolver('hear', async () => ({ on: true }));
    await refreshCapabilities();
    expect(listener).toHaveBeenCalledTimes(1);
    const [next, previous] = listener.mock.calls[0];
    expect(next.hear.on).toBe(true);
    expect(previous.hear.on).toBe(false);
    off();
  });

  test('a refresh requested while one runs is not lost', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    for (const cap of CAPABILITIES) setCapabilityResolver(cap, async () => ({ on: false }));
    setCapabilityResolver('draw', async () => {
      calls++;
      if (calls === 1) await gate;
      return { on: calls > 1 };
    });
    const first = refreshCapabilities();
    const second = refreshCapabilities();
    release();
    await Promise.all([first, second]);
    // The change made during the first computation is picked up by the second.
    expect(calls).toBe(2);
    expect(isCapabilityOn('draw')).toBe(true);
  });
});
