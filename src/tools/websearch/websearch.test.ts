import { describe, expect, test } from 'vitest';
import { buildSearxngParams } from './index';

describe('buildSearxngParams', () => {
  test('no allowlist → let the instance pick the general category', () => {
    const p = buildSearxngParams('dog friendly Chiemsee', null);
    expect(p.get('categories')).toBe('general');
    expect(p.get('engines')).toBeNull();
    expect(p.get('q')).toBe('dog friendly Chiemsee');
    expect(p.get('format')).toBe('json');
  });

  test('an allowlist is sent WITHOUT categories, or it would not restrict', () => {
    // Measured against a live SearXNG: categories+engines is a UNION, so
    // `categories=general&engines=bing` returns bing AND every other general
    // engine (30 results vs 10 for engines=bing alone). Sending both would
    // turn the allowlist into an "also include" list — the opposite of intent.
    const p = buildSearxngParams('q', 'google cse');
    expect(p.get('engines')).toBe('google cse');
    expect(p.get('categories')).toBeNull();
  });

  test('engine names with spaces survive encoding — "google cse" is a real name', () => {
    // The engine that actually works on this install has a space in its name;
    // shortcuts (`goc`) are NOT accepted by the `engines` param.
    expect(buildSearxngParams('q', 'google cse').toString()).toContain('engines=google+cse');
  });

  test('multiple engines pass through as a comma list', () => {
    expect(buildSearxngParams('q', 'google cse,duckduckgo').get('engines')).toBe('google cse,duckduckgo');
  });
});
