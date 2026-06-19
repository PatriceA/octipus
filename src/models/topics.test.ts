import { describe, expect, test } from 'bun:test';
import { ALL_TOPIC_VALUES, TEXT_TOPIC_VALUES, TOPICS } from './topics';
import { SINGLE_MODEL_CHAT_TOPICS } from './single-model-binding';

describe('canonical topic registry', () => {
  test('topic values are unique', () => {
    expect(new Set(ALL_TOPIC_VALUES).size).toBe(ALL_TOPIC_VALUES.length);
  });

  test('every topic has a label, description, and kind', () => {
    for (const t of TOPICS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(['text', 'background', 'vision', 'ocr', 'embedding']).toContain(t.kind);
    }
  });

  test('TEXT_TOPIC_VALUES excludes the non-text model classes', () => {
    for (const v of ['vision', 'ocr', 'embedding']) {
      expect(TEXT_TOPIC_VALUES).not.toContain(v);
      expect(ALL_TOPIC_VALUES).toContain(v); // but they ARE valid topics
    }
  });

  test('TEXT_TOPIC_VALUES = exactly the text + background kinds', () => {
    const expected = TOPICS.filter((t) => t.kind === 'text' || t.kind === 'background').map((t) => t.value);
    expect([...TEXT_TOPIC_VALUES]).toEqual(expected);
  });

  test('SINGLE_MODEL_CHAT_TOPICS is derived from the canonical text set (single source)', () => {
    expect([...SINGLE_MODEL_CHAT_TOPICS]).toEqual([...TEXT_TOPIC_VALUES]);
  });

  test('the core worker role topics are present and text-kind', () => {
    for (const role of ['general', 'coding', 'research', 'review', 'qa', 'security']) {
      const def = TOPICS.find((t) => t.value === role);
      expect(def?.kind).toBe('text');
    }
  });
});
