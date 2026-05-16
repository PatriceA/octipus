import { describe, test, expect } from 'bun:test';
import { looksWorthExtracting, parseExtractorResponse } from './extractor';
import { parseJudgeAction } from './judge';
import { renderMemoriesBlock } from './retrieval';
import type { Memory } from '@/db/schema/memories';

describe('memory.extractor', () => {
  test('looksWorthExtracting: short or no first-person → false', () => {
    expect(looksWorthExtracting('')).toBe(false);
    expect(looksWorthExtracting('what?')).toBe(false);
    expect(looksWorthExtracting('the weather is nice today')).toBe(false);
  });

  test('looksWorthExtracting: first-person → true', () => {
    expect(looksWorthExtracting('I prefer tabs over spaces')).toBe(true);
    expect(looksWorthExtracting('My team uses Postgres')).toBe(true);
    expect(looksWorthExtracting("i've been doing Go for 10 years")).toBe(true);
  });

  test('parseExtractorResponse: handles fenced JSON', () => {
    const raw = '```json\n{ "facts": [ { "fact_type": "preference", "content": "User prefers tabs", "confidence": 0.9 } ] }\n```';
    const facts = parseExtractorResponse(raw);
    expect(facts.length).toBe(1);
    expect(facts[0].factType).toBe('preference');
    expect(facts[0].confidence).toBe(0.9);
  });

  test('parseExtractorResponse: drops low-confidence facts', () => {
    const raw = JSON.stringify({
      facts: [
        { fact_type: 'preference', content: 'User prefers tabs', confidence: 0.9 },
        { fact_type: 'preference', content: 'Guessing user likes coffee', confidence: 0.2 },
      ],
    });
    const facts = parseExtractorResponse(raw);
    expect(facts.length).toBe(1);
    expect(facts[0].content).toContain('tabs');
  });

  test('parseExtractorResponse: invalid JSON → []', () => {
    expect(parseExtractorResponse('not json')).toEqual([]);
    expect(parseExtractorResponse('')).toEqual([]);
  });

  test('parseExtractorResponse: missing facts key → []', () => {
    expect(parseExtractorResponse('{"other": []}')).toEqual([]);
  });

  test('parseExtractorResponse: malformed entries skipped, valid entries kept', () => {
    const raw = JSON.stringify({
      facts: [
        { fact_type: 123, content: 'bad type', confidence: 0.9 },
        { fact_type: 'preference', confidence: 0.9 },
        { fact_type: 'preference', content: 'User likes Rust', confidence: 0.9 },
      ],
    });
    const facts = parseExtractorResponse(raw);
    expect(facts.length).toBe(1);
    expect(facts[0].content).toContain('Rust');
  });
});

describe('memory.judge', () => {
  test('parseJudgeAction: recognises all four actions, case-insensitive', () => {
    expect(parseJudgeAction('{"action":"ADD"}')).toBe('ADD');
    expect(parseJudgeAction('{"action":"update"}')).toBe('UPDATE');
    expect(parseJudgeAction('```json\n{"action":"DELETE"}\n```')).toBe('DELETE');
    expect(parseJudgeAction('{"action":"NOOP"}')).toBe('NOOP');
  });

  test('parseJudgeAction: unknown action → null', () => {
    expect(parseJudgeAction('{"action":"REWRITE"}')).toBe(null);
    expect(parseJudgeAction('not json')).toBe(null);
    expect(parseJudgeAction('{}')).toBe(null);
  });
});

describe('memory.retrieval', () => {
  test('renderMemoriesBlock: empty list → empty string', () => {
    expect(renderMemoriesBlock([])).toBe('');
  });

  test('renderMemoriesBlock: formats one line per memory', () => {
    const rows = [
      { factType: 'preference', content: 'User prefers tabs' },
      { factType: 'profile', content: 'User works at Acme' },
    ] as Memory[];
    const block = renderMemoriesBlock(rows);
    expect(block).toContain('Known about the user');
    expect(block).toContain('- (preference) User prefers tabs');
    expect(block).toContain('- (profile) User works at Acme');
  });
});
