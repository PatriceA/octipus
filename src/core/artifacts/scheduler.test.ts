import { describe, expect, test } from 'vitest';
import { getLastViewMs, recordArtifactView } from './scheduler';

describe('artifact view tracking', () => {
  test('recordArtifactView populates last-view', () => {
    recordArtifactView('art-1');
    const ts = getLastViewMs('art-1');
    expect(ts).not.toBeNull();
    expect(Date.now() - (ts ?? 0)).toBeLessThan(1000);
  });

  test('unseen artifact returns null', () => {
    expect(getLastViewMs('never-viewed')).toBeNull();
  });
});
