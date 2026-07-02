import { describe, expect, test } from 'bun:test';
import { ALL_TOPIC_VALUES, canonicalTopic, RETIRED_TOPIC_ALIASES, TEXT_TOPIC_VALUES, TOPICS } from './topics';
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

  test('the canonical lanes are present with the right kinds', () => {
    for (const lane of ['agents', 'chat', 'voice']) {
      expect(TOPICS.find((t) => t.value === lane)?.kind).toBe('text');
    }
    expect(TOPICS.find((t) => t.value === 'background')?.kind).toBe('background');
  });

  test('every retired worker-role topic canonicalizes to the agents lane', () => {
    for (const role of ['general', 'coding', 'research', 'architecture', 'review', 'communication',
      'design', 'devops', 'security', 'data', 'ai', 'qa', 'finance', 'automation', 'pm', 'writing']) {
      expect(canonicalTopic(role)).toBe('agents');
    }
  });

  test('every retired background topic canonicalizes to the background lane', () => {
    for (const t of ['memory_extraction', 'knowledge_review', 'evaluation', 'summarization', 'tool_translation']) {
      expect(canonicalTopic(t)).toBe('background');
    }
  });

  test('aliases only point at canonical topics; canonical values pass through', () => {
    for (const target of Object.values(RETIRED_TOPIC_ALIASES)) {
      expect(ALL_TOPIC_VALUES).toContain(target);
    }
    for (const v of ALL_TOPIC_VALUES) {
      expect(canonicalTopic(v)).toBe(v);
    }
    // Unknown topics pass through unchanged (fail-loud stays with the caller).
    expect(canonicalTopic('made-up-topic')).toBe('made-up-topic');
  });
});
