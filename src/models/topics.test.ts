import { describe, expect, test } from 'vitest';
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
      expect(['text', 'background', 'vision', 'ocr', 'embedding', 'decision']).toContain(t.kind);
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
    for (const lane of ['build', 'everyday', 'research']) {
      expect(TOPICS.find((t) => t.value === lane)?.kind).toBe('text');
    }
    expect(TOPICS.find((t) => t.value === 'background')?.kind).toBe('background');
  });

  test('the lanes `agents` split into are the only text lanes left beside research', () => {
    // A lane exists if and only if you would plausibly bind a DIFFERENT model to
    // it. `agents` held the coder and the weather question at once, which is
    // exactly why neither could be priced properly.
    const text = TOPICS.filter((t) => t.kind === 'text').map((t) => t.value);
    expect(text).toEqual(['build', 'everyday', 'verify', 'research']);
    for (const gone of ['agents', 'writing', 'chat', 'voice']) {
      expect(ALL_TOPIC_VALUES).not.toContain(gone);
    }
  });

  test('artefact work fails up into build', () => {
    // A weak model here does not stall, it ships junior output that looks
    // finished — so the ambiguous cases go to the expensive lane on purpose.
    for (const role of ['agents', 'coding', 'architecture', 'design',
      'devops', 'security', 'data', 'ai', 'finance', 'automation']) {
      expect(canonicalTopic(role)).toBe('build');
    }
  });

  test('review and qa get their own lane so they can run on a different model', () => {
    // The point of `verify` is not that review is a different subject — that is
    // how this registry once had twenty-seven topics — but that a second opinion
    // from the model that wrote the code is not a second opinion.
    for (const role of ['review', 'qa']) {
      expect(canonicalTopic(role)).toBe('verify');
    }
    expect(TOPICS.find((t) => t.value === 'verify')?.kind).toBe('text');
  });

  test('checkable work falls to everyday', () => {
    for (const role of ['general', 'communication', 'pm', 'writing', 'chat', 'voice', 'simple', 'local']) {
      expect(canonicalTopic(role)).toBe('everyday');
    }
  });

  test('research is its own lane, so a model bound to it is actually used', () => {
    // It used to alias to `writing`, which made the binding unreachable: the
    // highest-token role in the system could not be pinned to a cheap model.
    expect(canonicalTopic('research')).toBe('research');
    expect(ALL_TOPIC_VALUES).toContain('research');
    expect(TEXT_TOPIC_VALUES).toContain('research');
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
