/**
 * Per-arm persona shadowing (wave 4).
 *
 * The load-bearing property is the NEGATIVE one: an arm nobody bound must keep
 * carrying no persona at all. Workers have never had one, and quietly giving
 * every specialist the host's voice would change every worker prompt — and its
 * token cost — as a side effect of a feature nobody switched on.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { Profile, ProfileFact } from '@/db/schema/profiles';
import * as repository from './repository';
import { armFactKey, PersonaProfileRepository } from './repository';
import { getPersonaRegistry } from './registry';
import { resolvePersonaForArm } from './resolver';

const fact = (key: string, value: string): ProfileFact => ({
  key,
  value,
  source: 'user',
  learnedAt: new Date(0).toISOString(),
});

const profileWith = (facts: ProfileFact[], name = 'Adam'): Profile =>
  ({ id: 'profile-1', name, facts } as unknown as Profile);

/** Stand in for the DB read the resolver does. */
function withProfile(profile: Profile | null) {
  return spyOn(repository, 'getPersonaProfileRepository').mockReturnValue({
    findForUser: async () => profile,
  } as unknown as ReturnType<typeof repository.getPersonaProfileRepository>);
}

describe('toFields', () => {
  test('reads arm bindings out of the facts, leaving the others alone', () => {
    const fields = PersonaProfileRepository.toFields(
      profileWith([
        fact('preset_id', 'octipus'),
        fact('tone', 'dry'),
        fact('extra:0', 'always answer in bullets'),
        fact(armFactKey('review'), 'terse-engineer'),
        fact(armFactKey('writing'), 'verbose-academic'),
      ]),
    );
    expect(fields.armPresets).toEqual({ review: 'terse-engineer', writing: 'verbose-academic' });
    expect(fields.extras).toEqual(['always answer in bullets']);
    expect(fields.presetId).toBe('octipus');
  });

  test('no bindings is an empty map, not undefined', () => {
    expect(PersonaProfileRepository.toFields(profileWith([])).armPresets).toEqual({});
  });
});

describe('resolvePersonaForArm', () => {
  test('an unbound arm gets nothing — the pre-existing behaviour', async () => {
    const spy = withProfile(profileWith([fact('preset_id', 'mentor')]));
    expect(await resolvePersonaForArm('user-1', 'coding')).toBeNull();
    spy.mockRestore();
  });

  test('a user with no persona profile at all gets nothing', async () => {
    const spy = withProfile(null);
    expect(await resolvePersonaForArm('user-1', 'coding')).toBeNull();
    spy.mockRestore();
  });

  test('a bound arm speaks in the preset voice, under the user chosen name', async () => {
    await getPersonaRegistry().ensureLoaded();
    const preset = getPersonaRegistry().get('terse-engineer');
    expect(preset).toBeTruthy();

    const spy = withProfile(
      profileWith([
        fact('preset_id', 'mentor'),
        fact('tone', 'playful'),
        fact('extra:0', 'never use exclamation marks'),
        fact(armFactKey('review'), 'terse-engineer'),
      ]),
    );
    const shadow = await resolvePersonaForArm('user-1', 'review');
    spy.mockRestore();

    expect(shadow).not.toBeNull();
    // The PRESET supplies the voice…
    expect(shadow?.presetId).toBe('terse-engineer');
    expect(shadow?.tone).toBe(preset?.tone);
    // …while identity and the user's own rules carry over from the host.
    expect(shadow?.name).toBe('Adam');
    expect(shadow?.userFacts).toEqual(['never use exclamation marks']);
    expect(shadow?.promptBlock).toContain('never use exclamation marks');
    expect(shadow?.promptBlock.startsWith('--- PERSONA ---')).toBe(true);
    // An arm never narrates — the orchestrator does that.
    expect(shadow?.narration).toBe('off');
  });

  test('a preset that no longer exists degrades to no persona, not to a crash', async () => {
    const spy = withProfile(profileWith([fact(armFactKey('review'), 'deleted-preset')]));
    expect(await resolvePersonaForArm('user-1', 'review')).toBeNull();
    spy.mockRestore();
  });

  test('a profile read that throws degrades to no persona', async () => {
    const spy = spyOn(repository, 'getPersonaProfileRepository').mockReturnValue({
      findForUser: async () => { throw new Error('db down'); },
    } as unknown as ReturnType<typeof repository.getPersonaProfileRepository>);
    expect(await resolvePersonaForArm('user-1', 'review')).toBeNull();
    spy.mockRestore();
  });
});
