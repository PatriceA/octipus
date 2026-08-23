import { describe, expect, test } from 'vitest';
import { extractSection, normalizeVersion } from './changelog-extract';

const SAMPLE = `# Changelog

Intro prose that is not part of any section.

## Unreleased

### Feature A (2026-07-01)

- did a thing
- did another thing

### Feature B

- more

## 0.2.0 — 2026-06-01

- released 0.2.0 stuff

## 0.1.0

- first release
`;

describe('normalizeVersion', () => {
  test('strips a leading v and whitespace', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('  V0.2.0 ')).toBe('0.2.0');
    expect(normalizeVersion('0.1.0')).toBe('0.1.0');
  });
});

describe('extractSection', () => {
  test('extracts a matching version section (incl. its ### subsections)', () => {
    const body = extractSection(SAMPLE, '0.2.0');
    expect(body).toBe('- released 0.2.0 stuff');
  });

  test('matches a heading that contains the version even with extra text/date', () => {
    // "## 0.2.0 — 2026-06-01" contains "0.2.0"
    expect(extractSection(SAMPLE, 'v0.2.0')).toContain('released 0.2.0');
  });

  test('falls back to Unreleased when no version heading matches', () => {
    const body = extractSection(SAMPLE, '9.9.9');
    expect(body).toContain('### Feature A');
    expect(body).toContain('did a thing');
    expect(body).toContain('### Feature B');
    // Stops at the next h2, does not bleed into 0.2.0.
    expect(body).not.toContain('released 0.2.0');
  });

  test('h2 headings bound sections; ### subsections stay inside', () => {
    const body = extractSection(SAMPLE, 'Unreleased');
    expect(body.startsWith('### Feature A')).toBe(true);
    expect(body).not.toContain('## 0.2.0');
  });

  test('returns empty string when nothing matches and no Unreleased exists', () => {
    const noUnreleased = `# Changelog\n\n## 1.0.0\n\n- stuff\n`;
    expect(extractSection(noUnreleased, '2.0.0')).toBe('');
  });

  test('extracts the last section (bounded by EOF)', () => {
    expect(extractSection(SAMPLE, '0.1.0')).toBe('- first release');
  });
});
