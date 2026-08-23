import { afterEach, describe, expect, test } from 'vitest';
import { Persona } from './types';
import { getPersonaRegistry } from './registry';

const mkPersona = (id: string, isDefault = false): Persona => Persona.parse({
  id,
  is_default: isDefault,
  display_name: id,
  name: id,
  pronouns: 'it/we',
  tone: 'neutral',
  persona_prompt: 'A complete persona prompt block long enough to validate.',
  signature_phrases: [],
});

describe('PersonaRegistry', () => {
  afterEach(() => getPersonaRegistry()._resetForTesting());

  test('looks up by id', () => {
    getPersonaRegistry()._setForTesting([mkPersona('octipus', true), mkPersona('mentor')]);
    expect(getPersonaRegistry().get('octipus')?.id).toBe('octipus');
    expect(getPersonaRegistry().get('mentor')?.id).toBe('mentor');
    expect(getPersonaRegistry().get('missing')).toBeUndefined();
  });

  test('getDefault returns the octipus base', () => {
    getPersonaRegistry()._setForTesting([mkPersona('octipus', true), mkPersona('mentor')]);
    expect(getPersonaRegistry().getDefault().id).toBe('octipus');
  });

  test('getDefault throws when registry empty', () => {
    expect(() => getPersonaRegistry().getDefault()).toThrow(/not initialized/);
  });

  test('ensureLoaded loads from disk and registers the shipped octipus persona', async () => {
    getPersonaRegistry()._resetForTesting();
    await getPersonaRegistry().ensureLoaded();
    expect(getPersonaRegistry().get('octipus')).toBeDefined();
    expect(getPersonaRegistry().getDefault().name).toBe('Octipus');
  });

  test('ensureLoaded is idempotent (cached)', async () => {
    getPersonaRegistry()._resetForTesting();
    await getPersonaRegistry().ensureLoaded();
    const first = getPersonaRegistry().list().length;
    await getPersonaRegistry().ensureLoaded();
    expect(getPersonaRegistry().list().length).toBe(first);
  });
});
