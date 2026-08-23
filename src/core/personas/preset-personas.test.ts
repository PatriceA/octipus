import { describe, expect, test } from 'vitest';
import { join } from 'path';
import { loadPersonaFile } from './loader';

/**
 * Shipped preset personas. Sanity-checks each YAML loads cleanly and
 * meets the architectural rules — third-person Octipus identity, "we"
 * for collective work, no banned phrases.
 */

const PRESETS = ['octipus', 'terse-engineer', 'mentor', 'nautilus', 'concierge', 'verbose-academic'];

const BANNED_OPENERS = [
  /\bas an AI\b/i,
  /\bI am an AI\b/i,
  /\bI'm an AI\b/i,
];

describe('shipped persona presets', () => {
  for (const id of PRESETS) {
    test(`${id} loads and validates`, async () => {
      const path = join(process.cwd(), 'personas', `${id}.yaml`);
      const persona = await loadPersonaFile(path);
      expect(persona.id).toBe(id);
      expect(persona.persona_prompt.length).toBeGreaterThan(100);
      expect(persona.signature_phrases.length).toBeGreaterThan(0);
    });

    test(`${id} keeps the third-person + Octipus identity in the prompt`, async () => {
      const path = join(process.cwd(), 'personas', `${id}.yaml`);
      const persona = await loadPersonaFile(path);
      const prompt = persona.persona_prompt.toLowerCase();
      expect(prompt).toContain('octipus');
      expect(prompt).toContain('third person');
    });

    test(`${id} prompt contains no "as an AI" admissions`, async () => {
      const path = join(process.cwd(), 'personas', `${id}.yaml`);
      const persona = await loadPersonaFile(path);
      for (const re of BANNED_OPENERS) {
        // The persona prompt may MENTION these as banned, but we check
        // that the prompt isn't itself written from that voice. Allow
        // mentions when followed by "Never" / negation patterns.
        const match = persona.persona_prompt.match(re);
        if (match) {
          const ctx = persona.persona_prompt.slice(Math.max(0, match.index! - 30), match.index! + 30).toLowerCase();
          // OK if banned-phrase appears alongside "never" / "no" / "do not"
          expect(ctx).toMatch(/never|no |do not|don't/);
        }
      }
    });
  }

  test('exactly one persona is marked is_default', async () => {
    let defaults = 0;
    for (const id of PRESETS) {
      const path = join(process.cwd(), 'personas', `${id}.yaml`);
      const p = await loadPersonaFile(path);
      if (p.is_default) defaults++;
    }
    expect(defaults).toBe(1);
  });
});
