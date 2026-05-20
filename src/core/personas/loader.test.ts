import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAllPersonas, loadPersonaFile } from './loader';
import { parseYaml } from './yaml';

describe('persona YAML parser', () => {
  test('parses simple scalars and arrays', () => {
    const out = parseYaml(`
id: test
name: Octipus
signature_phrases:
  - "Acknowledged."
  - "More."
`);
    expect(out).toEqual({
      id: 'test',
      name: 'Octipus',
      signature_phrases: ['Acknowledged.', 'More.'],
    });
  });

  test('parses block scalars (|) with preserved newlines', () => {
    const out = parseYaml(`
id: test
prompt: |
  Line one.
  Line two.
`) as Record<string, string>;
    expect(out.prompt).toContain('Line one.');
    expect(out.prompt).toContain('Line two.');
    expect(out.prompt).toContain('\n');
  });

  test('parses arrays of mappings (example_exchanges)', () => {
    const out = parseYaml(`
exchanges:
  - user: "hi"
    octipus: "hello"
  - user: "thanks"
    octipus: "noted"
`) as { exchanges: Array<{ user: string; octipus: string }> };
    expect(out.exchanges).toHaveLength(2);
    expect(out.exchanges[0].user).toBe('hi');
    expect(out.exchanges[0].octipus).toBe('hello');
  });
});

describe('loadPersonaFile', () => {
  test('loads the shipped base persona', async () => {
    const path = join(process.cwd(), 'personas', 'octipus.yaml');
    const persona = await loadPersonaFile(path);
    expect(persona.id).toBe('octipus');
    expect(persona.name).toBe('Octipus');
    expect(persona.is_default).toBe(true);
    expect(persona.tone).toBe('dry');
    expect(persona.persona_prompt.length).toBeGreaterThan(100);
    expect(persona.signature_phrases.length).toBeGreaterThan(0);
  });

  test('throws on missing file', async () => {
    await expect(loadPersonaFile('/nonexistent/path.yaml')).rejects.toThrow();
  });

  test('throws on invalid persona', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-test-'));
    try {
      const path = join(dir, 'broken.yaml');
      writeFileSync(path, 'id: broken\nname: x\n');
      await expect(loadPersonaFile(path)).rejects.toThrow(/persona_prompt/i);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('loadAllPersonas', () => {
  test('finds the base persona from the personas/ dir', async () => {
    const all = await loadAllPersonas();
    expect(all.length).toBeGreaterThan(0);
    expect(all.find(p => p.id === 'octipus')).toBeDefined();
  });

  test('skips broken files but returns valid ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-test-'));
    try {
      writeFileSync(join(dir, 'broken.yaml'), 'id: broken\n');
      writeFileSync(join(dir, 'good.yaml'), `
id: good
display_name: Good
name: Good
pronouns: it/we
tone: neutral
persona_prompt: |
  This is a complete, valid persona prompt block used in tests.
signature_phrases:
  - "Hello."
`);
      const all = await loadAllPersonas(dir);
      expect(all.find(p => p.id === 'good')).toBeDefined();
      expect(all.find(p => p.id === 'broken')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
