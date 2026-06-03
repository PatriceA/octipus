import { describe, expect, test } from 'bun:test';
import { CATALOG_VERSION, getCatalogEntry, MODEL_CATALOG } from './catalog';
import { KNOWN_QUANTS, KNOWN_TOPICS } from './types';

const QUANTS = new Set<string>(KNOWN_QUANTS);
const TOPICS = new Set<string>(KNOWN_TOPICS);

describe('catalog conformance', () => {
  test('has a version and at least a handful of entries', () => {
    expect(CATALOG_VERSION).toBeGreaterThanOrEqual(1);
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  test('every entry is well-formed', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.id, 'id present').toBeTruthy();
      expect(m.id.includes(':'), `${m.id} should be a tagged Ollama id`).toBe(true);
      expect(m.family, `${m.id} family`).toBeTruthy();
      expect(m.params, `${m.id} params`).toBeGreaterThan(0);
      expect(QUANTS.has(m.quant), `${m.id} quant '${m.quant}' is known`).toBe(true);
      expect(m.vramHintMB, `${m.id} vramHintMB fallback`).toBeGreaterThan(0);
      expect(m.contextWindow, `${m.id} contextWindow`).toBeGreaterThan(0);
      expect(m.topics.length, `${m.id} has topics`).toBeGreaterThan(0);
      for (const t of m.topics) {
        expect(TOPICS.has(t), `${m.id} topic '${t}' maps to a known topic`).toBe(true);
      }
    }
  });

  test('ids are unique', () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every known topic has at least one catalog model', () => {
    for (const topic of KNOWN_TOPICS) {
      const hit = MODEL_CATALOG.some((m) => m.topics.includes(topic));
      expect(hit, `topic '${topic}' should have a model`).toBe(true);
    }
  });

  test('getCatalogEntry looks up by id', () => {
    const first = MODEL_CATALOG[0];
    expect(first).toBeDefined();
    expect(getCatalogEntry(first!.id)).toBe(first!);
    expect(getCatalogEntry('does-not-exist:1b')).toBeUndefined();
  });
});
