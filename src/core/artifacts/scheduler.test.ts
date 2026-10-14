import { describe, expect, test } from 'vitest';
import { getLastViewMs, MAX_TRACKED_VIEWS, recordArtifactView } from './scheduler';

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

test('the least recently viewed artifact is forgotten past the cap', () => {
  recordArtifactView('cap-first');
  recordArtifactView('cap-second');
  recordArtifactView('cap-first'); // viewed again: now the newer of the two
  for (let i = 0; i < MAX_TRACKED_VIEWS - 1; i++) recordArtifactView(`cap-filler-${i}`);
  expect(getLastViewMs('cap-second')).toBeNull();
  expect(getLastViewMs('cap-first')).not.toBeNull();
});
