import { describe, expect, test } from 'vitest';
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
      { factType: 'preference', content: 'User prefers tabs', confidence: 1 },
      { factType: 'profile', content: 'User works at Acme', confidence: 1 },
    ] as Memory[];
    const block = renderMemoriesBlock(rows);
    expect(block).toContain('Known about the user');
    expect(block).toContain('- (preference) User prefers tabs');
    expect(block).toContain('- (profile) User works at Acme');
  });

  test('renderMemoriesBlock: high-confidence facts omit the probability tag', () => {
    const rows = [{ factType: 'preference', content: 'X', confidence: 0.95 }] as Memory[];
    const out = renderMemoriesBlock(rows);
    expect(out).toContain('(preference) X');
    expect(out).not.toContain('p≈');
  });

  test('renderMemoriesBlock: low-confidence facts surface the probability', () => {
    const rows = [{ factType: 'preference', content: 'Maybe X', confidence: 0.6 }] as Memory[];
    const out = renderMemoriesBlock(rows);
    expect(out).toContain('p≈0.60');
    expect(out).toContain('(preference, p≈0.60)');
  });

  test('renderMemoriesBlock: defends against undefined confidence (treats as 1)', () => {
    const rows = [{ factType: 'profile', content: 'Z' }] as unknown as Memory[];
    expect(renderMemoriesBlock(rows)).not.toContain('p≈');
  });
});

describe('memory.extractor — edge cases', () => {
  test('looksWorthExtracting: matches contractions and possessives', () => {
    expect(looksWorthExtracting("I'm a TS developer")).toBe(true);
    expect(looksWorthExtracting('My company uses Slack')).toBe(true);
  });

  test('looksWorthExtracting: short or non-pronoun input → false', () => {
    expect(looksWorthExtracting('I')).toBe(false);
    expect(looksWorthExtracting('imine')).toBe(false);
  });

  test('parseExtractorResponse: confidence at exactly 0.5 is kept (boundary)', () => {
    const raw = JSON.stringify({
      facts: [{ fact_type: 'preference', content: 'borderline', confidence: 0.5 }],
    });
    const facts = parseExtractorResponse(raw);
    expect(facts.length).toBe(1);
    expect(facts[0].confidence).toBe(0.5);
  });

  test('parseExtractorResponse: confidence just below 0.5 is dropped', () => {
    const raw = JSON.stringify({
      facts: [{ fact_type: 'preference', content: 'iffy', confidence: 0.49 }],
    });
    expect(parseExtractorResponse(raw)).toEqual([]);
  });

  test('parseExtractorResponse: trims content whitespace', () => {
    const raw = JSON.stringify({
      facts: [{ fact_type: 'profile', content: '   User loves Rust   ', confidence: 0.9 }],
    });
    const facts = parseExtractorResponse(raw);
    expect(facts[0].content).toBe('User loves Rust');
  });
});
